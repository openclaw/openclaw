import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import {
  registerRuntimeConfigWriteListener,
  setRuntimeConfigSnapshotRefreshHandler,
} from "../../config/runtime-snapshot.js";
import {
  getRuntimeConfigWriteApplication,
  type RuntimeConfigWriteApplicationClaim,
} from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { completeProviderModelAccess, prepareProviderModelAccess } from "./auth-model-policy.js";
import { updateConfig } from "./shared.js";

describe("provider model access consent", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let config: OpenClawConfig;
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const prompter = createWizardPrompter({ select: async ({ options }) => options[0]!.value });
  const prepare = () =>
    prepareProviderModelAccess({
      config,
      agentId: "main",
      provider: "sample",
      providerLabel: "Sample",
    });
  const readSaved = async (): Promise<OpenClawConfig> =>
    JSON.parse(await fs.readFile(state.configPath, "utf8"));

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "model-access-consent" });
    config = {
      agents: {
        defaults: { model: "other/current", modelPolicy: { allow: ["other/current"] } },
        entries: { main: { workspace: state.workspaceDir } },
      },
    };
    await state.writeConfig(config);
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await state.cleanup();
  });

  it.each([undefined, [], ["sample/*"]])(
    "does not ask for an unrestricted provider: %j",
    (allow) => {
      config.agents!.defaults!.modelPolicy = allow ? { allow } : undefined;
      expect(prepare()).toBeUndefined();
    },
  );

  it.each(["defaults", "agent", "legacy"])("widens only the consenting %s owner", async (owner) => {
    if (owner === "agent") {
      config.agents!.entries!.main!.modelPolicy = { allow: ["other/private"] };
    } else if (owner === "legacy") {
      delete config.agents!.defaults!.modelPolicy;
      config.agents!.defaults!.models = { "other/current": {} };
    }
    await state.writeConfig(config);
    const outcome = await completeProviderModelAccess({ prepared: prepare(), prompter, runtime });
    expect(outcome).toContain("Application by the running Gateway is not confirmed");
    expect(outcome).toContain("openclaw gateway restart");
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("models are now visible"));
    const saved = await readSaved();
    expect(saved.agents?.defaults?.model).toBe("other/current");
    expect(saved.agents?.defaults?.modelPolicy?.allow).toEqual(
      owner === "agent" ? ["other/current"] : ["other/current", "sample/*"],
    );
    if (owner === "agent") {
      expect(saved.agents?.entries?.main?.modelPolicy?.allow).toEqual([
        "other/private",
        "sample/*",
      ]);
    }
  });

  it("keeps restrictions without writing config", async () => {
    const before = await fs.readFile(state.configPath, "utf8");
    await completeProviderModelAccess({
      prepared: prepare(),
      runtime,
      prompter: createWizardPrompter({ select: async ({ options }) => options[1]!.value }),
    });
    expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
  });

  it("preserves deferred legacy restrictions across consent and later config writes", async () => {
    delete config.agents!.defaults!.modelPolicy;
    config.agents!.defaults!.models = { "existing-model": {} };
    await state.writeConfig(config);
    await completeProviderModelAccess({ prepared: prepare(), prompter, runtime });
    await updateConfig((current) => ({ ...current, logging: { level: "debug" } }));
    const saved = await readSaved();
    expect(saved.agents?.defaults?.models).toEqual({ "existing-model": {}, "sample/*": {} });
    expect(saved.agents?.defaults?.modelPolicy).toBeUndefined();
    expect(saved.meta?.migrations?.modelPolicyAllowlist).not.toBe(true);
    config = saved;
    expect(prepare()).toBeUndefined();
  });

  it("does not infer consent from a migrated model map", () => {
    delete config.agents!.defaults!.modelPolicy;
    config.agents!.defaults!.models = { "other/current": {} };
    config.meta = { migrations: { modelPolicyAllowlist: true } };
    expect(prepare()).toBeUndefined();
  });

  it("rechecks login authority after the writer's asynchronous preflight", async () => {
    const before = await fs.readFile(state.configPath, "utf8");
    let active = true;
    setRuntimeConfigSnapshotRefreshHandler({
      preflight: async () => {
        active = false;
      },
      refresh: () => true,
    });
    try {
      await expect(
        completeProviderModelAccess({
          prepared: prepare(),
          prompter,
          runtime,
          assertCurrent: () => {
            if (!active) {
              throw new Error("Login replaced");
            }
          },
        }),
      ).rejects.toThrow("Login replaced");
      expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  it.each(["replacement", "removed-owner", "late-change"])(
    "rejects consent after %s",
    async (change) => {
      config.agents!.entries!.main!.modelPolicy = { allow: ["other/private"] };
      await state.writeConfig(config);
      const prepared = prepare();
      const replace = async () => {
        if (change === "removed-owner") {
          delete config.agents!.entries!.main!.modelPolicy;
        } else {
          config.agents!.entries!.main!.modelPolicy = { allow: ["other/replacement"] };
        }
        await state.writeConfig(config);
      };
      if (change !== "late-change") {
        await replace();
      }
      await expect(
        completeProviderModelAccess({
          prepared,
          runtime,
          prompter: createWizardPrompter({
            select: async ({ options }) => {
              if (change === "late-change") {
                await replace();
              }
              return options[0]!.value;
            },
          }),
        }),
      ).rejects.toThrow("Model restrictions changed during sign-in");
      const saved = await readSaved();
      expect(saved.agents?.defaults?.modelPolicy?.allow).toEqual(["other/current"]);
      expect(saved.agents?.entries?.main?.modelPolicy?.allow).toEqual(
        change === "removed-owner" ? undefined : ["other/replacement"],
      );
    },
  );

  it.each(["applied", "failed"] as const)(
    "waits for exact runtime application: %s",
    async (status) => {
      const claimReady = createDeferredCore<RuntimeConfigWriteApplicationClaim>();
      const stop = registerRuntimeConfigWriteListener((event) => {
        const claim = getRuntimeConfigWriteApplication(event)?.claim();
        if (claim) {
          claimReady.resolve(claim);
        }
      });
      let complete = false;
      const result = completeProviderModelAccess({ prepared: prepare(), prompter, runtime });
      void result.then(
        () => {
          complete = true;
        },
        () => {
          complete = true;
        },
      );
      try {
        const claim = await claimReady.promise;
        expect(complete).toBe(false);
        claim.settle(status);
        if (status === "applied") {
          await expect(result).resolves.toBe("All Sample models are now visible.");
        } else {
          await expect(result).rejects.toThrow("did not apply");
        }
      } finally {
        stop();
      }
    },
  );
});
