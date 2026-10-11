// Setup inference verification tests keep noninteractive imports prompt-free.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readAuthProfileStoreForTest,
  removeOAuthTestTempRoot,
} from "../agents/auth-profiles/oauth-test-utils.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/profiles.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SetupInferenceConfigTarget } from "../system-agent/setup-inference-transition.js";
import type { WizardPrompter } from "./prompts.js";
import type { SetupModelAuthCandidate } from "./setup.model-auth.js";

const mocks = vi.hoisted(() => ({
  repair: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("../system-agent/setup-inference.js", () => ({
  verifySetupInferenceConfig: mocks.verify,
}));
vi.mock("./setup.model-auth.js", () => ({
  runSetupModelAuthStep: mocks.repair,
}));

import { offerLiveModelVerification } from "./setup.inference-verification.js";

function verifyWithMemoryConfig(
  params: Omit<Parameters<typeof offerLiveModelVerification>[0], "configTarget"> & {
    writeConfig: (config: OpenClawConfig) => Promise<OpenClawConfig>;
  },
) {
  let current = structuredClone(params.config);
  const target: SetupInferenceConfigTarget = {
    write: async (config, options) => {
      const before = current;
      options.captureUndo(async () => {
        current = before;
        return { config: current, written: true };
      });
      current = await params.writeConfig(config);
      return current;
    },
    read: async () => ({ config: current, write: target.write }),
  };
  return offerLiveModelVerification({ ...params, configTarget: target });
}

const tempRoots = createTempDirTracker();
afterEach(() => tempRoots.cleanup());

function createPrompter(): WizardPrompter {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(),
    text: vi.fn(),
    progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
  } as WizardPrompter;
}

describe("offerLiveModelVerification", () => {
  beforeEach(() => {
    mocks.repair.mockReset();
    mocks.verify.mockReset();
  });

  it("preserves a working profile when a rejected replacement is retried without another login", async () => {
    const stateDir = await fs.realpath(tempRoots.make("openclaw-working-setup-profile-"));
    const agentDir = path.join(stateDir, "import-agent");
    const working = {
      profileId: "openai:working",
      credential: { type: "api_key" as const, provider: "openai", key: "working-key" },
    };
    await upsertAuthProfileWithLock({ ...working, agentDir });
    const config: OpenClawConfig = {
      browser: { enabled: false },
      agents: {
        ownership: "explicit",
        entries: { main: {} },
        defaults: { model: "openai/test-model@openai:working" },
      },
      auth: { profiles: { "openai:working": { provider: "openai", mode: "api_key" } } },
    };
    const before = structuredClone(config);
    const replacement = { ...working, credential: { ...working.credential, key: "rejected-key" } };
    const persistAuthProfiles = vi.fn(
      async (profiles: SetupModelAuthCandidate["authProfiles"] = [replacement]) => {
        for (const profile of profiles) {
          await upsertAuthProfileWithLock({ ...profile, agentDir });
        }
      },
    );
    const candidate: SetupModelAuthCandidate = {
      config: { ...config, agents: { ...config.agents, defaults: { model: "openai/test-model" } } },
      authProfiles: [replacement],
      persistAuthProfiles,
    };
    const attemptedProfiles: string[] = [];
    mocks.verify.mockImplementation(async ({ config: tested }: { config: OpenClawConfig }) => {
      const primary = expectDefined(
        resolveAgentModelPrimaryValue(tested.agents?.defaults?.model),
        "selected model",
      );
      const profileId = expectDefined(
        splitTrailingAuthProfile(primary).profile,
        "selected credential profile",
      );
      attemptedProfiles.push(profileId);
      const store = readAuthProfileStoreForTest(agentDir);
      expect(profileId).toMatch(/^openai:setup-/);
      expect(store.profiles[profileId]).toMatchObject({
        ...replacement.credential,
        setup: {
          replacement: true,
          modelRef: "openai/test-model",
          configJson: expect.any(String),
        },
      });
      expect(store.profiles[working.profileId]).toEqual(working.credential);
      expect(tested.browser).toEqual({ enabled: false });
      return { ok: false, status: "auth", error: "credential rejected" };
    });
    const writeConfig = vi.fn(async (next: OpenClawConfig) => next);
    const params = {
      config,
      initialCandidate: candidate,
      opts: { nonInteractive: true },
      prompter: createPrompter(),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      stateDir,
      agentDir,
      writeConfig,
      required: true,
    };
    try {
      await expect(verifyWithMemoryConfig(params)).resolves.toMatchObject({
        verified: false,
        persisted: false,
      });
      await expect(verifyWithMemoryConfig(params)).resolves.toMatchObject({
        verified: false,
        persisted: false,
      });
      expect(attemptedProfiles).toHaveLength(2);
      expect(attemptedProfiles[1]).toBe(attemptedProfiles[0]);
      expect(Object.keys(readAuthProfileStoreForTest(agentDir).profiles)).toHaveLength(2);
      expect(persistAuthProfiles).toHaveBeenCalledOnce();
      expect(writeConfig).not.toHaveBeenCalled();
      expect(mocks.repair).not.toHaveBeenCalled();
      expect(params.prompter.select).not.toHaveBeenCalled();
      expect(config).toEqual(before);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("reports when a repair candidate persisted its verified config", async () => {
    const repairedConfig: OpenClawConfig = {
      agents: { entries: { main: {} } },
      models: {
        providers: {
          openai: { apiKey: "test-key", baseUrl: "https://api.openai.com/v1", models: [] },
        },
      },
    };
    const persistAuthProfiles = vi.fn(async () => {});
    const writeConfig = vi.fn(async () => repairedConfig);
    mocks.verify
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "credential expired" })
      .mockResolvedValueOnce({ ok: true, modelRef: "openai/gpt-5.6", latencyMs: 10 });
    mocks.repair.mockResolvedValue({
      config: repairedConfig,
      authProfiles: [],
      persistAuthProfiles,
    });
    const prompter = {
      ...createPrompter(),
      confirm: vi.fn(async () => true),
      select: vi.fn(async () => "fix") as WizardPrompter["select"],
    };

    await expect(
      verifyWithMemoryConfig({
        config: { agents: { entries: { main: {} } } },
        opts: {},
        prompter,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
        writeConfig,
      }),
    ).resolves.toEqual({
      config: repairedConfig,
      attempted: true,
      persisted: true,
      verified: true,
      modelRef: "openai/gpt-5.6",
    });
    expect(writeConfig).toHaveBeenCalledOnce();
  });

  it("requires managed local model verification and keeps a failed candidate uncommitted", async () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: "local-fixture/model" } },
      models: {
        providers: {
          "local-fixture": {
            baseUrl: "http://127.0.0.1:12345/v1",
            models: [],
            localService: { command: "/fixture/server" },
          },
        },
      },
    };
    const persistAuthProfiles = vi.fn(async () => {});
    const writeConfig = vi.fn(async (next: OpenClawConfig) => next);
    const prompter = createPrompter();
    mocks.verify.mockResolvedValue({
      ok: false,
      status: "format",
      error: "inference request failed",
    });
    mocks.repair.mockRejectedValue(new Error("repair cancelled"));
    await expect(
      verifyWithMemoryConfig({
        config,
        initialCandidate: { config, authProfiles: [], persistAuthProfiles },
        opts: {},
        prompter,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        writeConfig,
      }),
    ).rejects.toThrow("repair cancelled");
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(prompter.select).not.toHaveBeenCalled();
    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("leaves verification of an existing managed route optional", async () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: "local-fixture/model" } },
      models: {
        providers: {
          "local-fixture": {
            baseUrl: "http://127.0.0.1:12345/v1",
            models: [],
            localService: { command: "/fixture/server" },
          },
        },
      },
    };
    const prompter = createPrompter();
    vi.mocked(prompter.confirm).mockResolvedValue(false);
    const writeConfig = vi.fn(async (next: OpenClawConfig) => next);
    expect(
      await verifyWithMemoryConfig({
        config,
        opts: {},
        prompter,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        writeConfig,
      }),
    ).toMatchObject({ attempted: false, verified: false, persisted: false });
    expect(prompter.confirm).toHaveBeenCalledOnce();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });
});
