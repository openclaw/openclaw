import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import { setRuntimeConfigSnapshotRefreshHandler } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { completeProviderModelAccess, prepareProviderModelAccess } from "./auth-model-policy.js";
import { updateConfig } from "./shared.js";

describe("provider model access consent", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let config: OpenClawConfig;
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const choose = (index = 0, beforeSelect?: () => Promise<unknown>) =>
    createWizardPrompter({
      select: async ({ options }) => {
        await beforeSelect?.();
        return options[index]!.value;
      },
    });
  const identity = { agentId: "main", provider: "sample", providerLabel: "Sample" };
  const prepare = () => prepareProviderModelAccess({ config, ...identity });
  const readSaved = async (): Promise<OpenClawConfig> =>
    JSON.parse(await fs.readFile(state.configPath, "utf8"));
  const readBytes = () => fs.readFile(state.configPath, "utf8");
  const complete = (options: Partial<Parameters<typeof completeProviderModelAccess>[0]> = {}) =>
    completeProviderModelAccess({ prepared: prepare(), prompter: choose(), runtime, ...options });
  async function restrictOwner() {
    config.agents!.entries!.main!.modelPolicy = { allow: ["other/private"] };
    await state.writeConfig(config);
  }

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
    setRuntimeConfigSnapshotRefreshHandler(null);
    await state.cleanup();
  });

  it("widens only the consenting agent owner", async () => {
    await restrictOwner();
    const outcome = await complete();
    expect(outcome.message).toContain("Application by the running Gateway is not confirmed");
    expect(outcome.message).toContain("openclaw gateway restart");
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("models are now visible"));
    const saved = await readSaved();
    expect(saved.agents).toMatchObject({
      defaults: { model: "other/current", modelPolicy: { allow: ["other/current"] } },
      entries: { main: { modelPolicy: { allow: ["other/private", "sample/*"] } } },
    });
  });

  it("keeps restrictions without writing config", async () => {
    const before = await readBytes();
    await complete({ prompter: choose(1) });
    expect(await readBytes()).toBe(before);
  });

  it("preserves deferred legacy restrictions across consent and later config writes", async () => {
    delete config.agents!.defaults!.modelPolicy;
    config.agents!.defaults!.models = { "existing-model": {} };
    await state.writeConfig(config);
    await complete();
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
    const before = await readBytes();
    const assertCurrent = vi.fn();
    setRuntimeConfigSnapshotRefreshHandler({
      preflight: async () => {
        assertCurrent.mockImplementation(() => {
          throw new Error("Login replaced");
        });
      },
      refresh: () => true,
    });
    await expect(complete({ assertCurrent })).rejects.toThrow("Login replaced");
    expect(await readBytes()).toBe(before);
  });

  it.each([undefined, { allow: ["other/replacement"] }])(
    "rejects removed or replaced consent owner: %j",
    async (replacement) => {
      await restrictOwner();
      const prepared = prepare();
      const replace = async () => {
        config.agents!.entries!.main!.modelPolicy = replacement;
        await state.writeConfig(config);
      };
      if (!replacement) {
        await replace();
      }
      await expect(
        complete({
          prepared,
          prompter: choose(0, replacement ? replace : undefined),
        }),
      ).rejects.toThrow("Model restrictions changed during sign-in");
      const saved = await readSaved();
      expect(saved.agents?.defaults?.modelPolicy?.allow).toEqual(["other/current"]);
      expect(saved.agents?.entries?.main?.modelPolicy?.allow).toEqual(replacement?.allow);
    },
  );
});
