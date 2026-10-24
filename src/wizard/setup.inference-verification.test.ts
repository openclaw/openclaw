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
import { resolveRunWorkspaceDir } from "../agents/workspace-run.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SetupInferenceConfigTarget } from "../system-agent/setup-inference-transition.js";
import { verifySetupInferenceConfig } from "../system-agent/setup-inference-turn.js";
import { authCandidate, createEmptyWizardPrompter } from "./setup.credentials.test-support.js";
import type { SetupModelAuthCandidate } from "./setup.model-auth.js";

const mocks = vi.hoisted(() => ({
  repair: vi.fn(),
  verify: vi.fn(),
  runEmbedded: vi.fn<typeof import("../agents/embedded-agent.js").runEmbeddedAgent>(),
}));

vi.mock("../system-agent/setup-inference.js", () => ({
  verifySetupInferenceConfig: mocks.verify,
}));
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.runEmbedded }));
vi.mock("./setup.model-auth.js", () => ({
  runSetupModelAuthStep: mocks.repair,
}));

import { offerLiveModelVerification } from "./setup.inference-verification.js";

type VerificationParams = Parameters<typeof offerLiveModelVerification>[0];
type VerificationOptions = Partial<
  Omit<VerificationParams, "config" | "configTarget" | "runtime" | "prompter">
>;

function verificationFixture(config: OpenClawConfig, options: VerificationOptions = {}) {
  const prompter = createEmptyWizardPrompter();
  const writeConfig = vi.fn(async (next: OpenClawConfig) => next);
  let current = structuredClone(config);
  const target: SetupInferenceConfigTarget = {
    write: async (next, writeOptions) => {
      const before = current;
      writeOptions.captureUndo(async () => {
        current = before;
        return { config: current, written: true };
      });
      current = await writeConfig(next);
      return current;
    },
    read: async () => ({ config: current, write: target.write }),
  };
  return {
    prompter,
    writeConfig,
    run: () =>
      offerLiveModelVerification({
        config,
        opts: {},
        prompter,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        ...options,
        assertCurrent: options.assertCurrent ?? (() => {}),
        configTarget: target,
      }),
  };
}

const tempRoots = createTempDirTracker();
afterEach(() => tempRoots.cleanup());

function expectNotCalled(...functions: ReturnType<typeof vi.fn>[]) {
  for (const fn of functions) {
    expect(fn).not.toHaveBeenCalled();
  }
}

const managedConfig: OpenClawConfig = {
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

describe("offerLiveModelVerification", () => {
  beforeEach(() => {
    mocks.repair.mockReset();
    mocks.verify.mockReset();
    mocks.runEmbedded.mockReset();
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
    const { run, writeConfig, prompter } = verificationFixture(config, {
      initialCandidate: candidate,
      opts: { nonInteractive: true },
      stateDir,
      agentDir,
      required: true,
    });
    try {
      const rejected = { verified: false, persisted: false };
      await expect(run()).resolves.toMatchObject(rejected);
      await expect(run()).resolves.toMatchObject(rejected);
      expect(attemptedProfiles).toHaveLength(2);
      expect(attemptedProfiles[1]).toBe(attemptedProfiles[0]);
      expect(Object.keys(readAuthProfileStoreForTest(agentDir).profiles)).toHaveLength(2);
      expect(persistAuthProfiles).toHaveBeenCalledOnce();
      expectNotCalled(writeConfig, mocks.repair, vi.mocked(prompter.select));
      expect(config).toEqual(before);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it.each(["research", undefined])(
    "keeps explicit owner %s runtime-only during verification",
    async (owner) => {
      const harness = owner ? "codex" : undefined;
      const root = await fs.realpath(tempRoots.make("openclaw-staged-verification-"));
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: owner ? { [owner]: {} } : {},
          defaults: {
            model: { primary: "openai/gpt-5.6-luna" },
            ...(harness
              ? { models: { "openai/gpt-5.6-luna": { agentRuntime: { id: harness } } } }
              : {}),
          },
        },
      };
      const before = structuredClone(config);
      const agentDir = path.join(root, "agents", owner ?? "main", "agent");
      const runEmbeddedAgent = mocks.runEmbedded.mockImplementation(async (params) => {
        expect(params).toMatchObject({
          agentDir,
          provider: "openai",
          model: "gpt-5.6-luna",
          agentHarnessRuntimeOverride: harness,
          authProfileStateMode: "read-only",
          sessionKey: expect.stringMatching(new RegExp(`^agent:${owner}:setup-inference:`)),
        });
        expect(resolveRunWorkspaceDir(params).agentId).toBe(owner);
        return {
          payloads: [{ text: "OK" }],
          meta: {
            durationMs: 1,
            executionTrace: { winnerProvider: params.provider, winnerModel: params.model },
          },
        };
      });
      mocks.verify.mockImplementation((params: Parameters<typeof verifySetupInferenceConfig>[0]) =>
        verifySetupInferenceConfig(params),
      );
      const initialCandidate = authCandidate(config);
      const { run, writeConfig } = verificationFixture(config, {
        initialCandidate,
        opts: { nonInteractive: true },
        agentDir,
        stateDir: root,
        required: true,
      });
      const verification = run();
      if (owner) {
        await expect(verification).resolves.toMatchObject({
          verified: true,
          persisted: true,
          config: before,
        });
        expect(writeConfig).toHaveBeenCalledOnce();
        expect(writeConfig.mock.calls[0]?.[0]).toEqual(before);
        expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      } else {
        await expect(verification).rejects.toThrow("No agents configured");
        expectNotCalled(writeConfig, initialCandidate.persistAuthProfiles, runEmbeddedAgent);
      }
      expect(config).toEqual(before);
    },
  );

  it("stops verification progress when the provider check rejects", async () => {
    const verificationError = new Error("provider network dropped");
    mocks.verify.mockRejectedValue(verificationError);
    const { run, prompter } = verificationFixture(
      { agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } } },
      { opts: { nonInteractive: true }, required: true },
    );
    const stop = vi.fn();
    vi.mocked(prompter.progress).mockReturnValue({ stop, update: vi.fn() });
    await expect(run()).rejects.toBe(verificationError);
    expect(stop).toHaveBeenCalledOnce();
    expectNotCalled(vi.mocked(prompter.note), mocks.repair);
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
    mocks.verify
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "credential expired" })
      .mockResolvedValueOnce({ ok: true, modelRef: "openai/gpt-5.6", latencyMs: 10 });
    mocks.repair.mockResolvedValue(authCandidate(repairedConfig));
    const { run, prompter, writeConfig } = verificationFixture({
      agents: { entries: { main: {} } },
    });
    writeConfig.mockResolvedValue(repairedConfig);
    vi.mocked(prompter.confirm).mockResolvedValue(true);
    vi.mocked(prompter.select).mockResolvedValue("fix");
    await expect(run()).resolves.toEqual({
      config: repairedConfig,
      attempted: true,
      persisted: true,
      verified: true,
      modelRef: "openai/gpt-5.6",
    });
    expect(writeConfig).toHaveBeenCalledOnce();
  });

  it("requires managed local model verification and keeps a failed candidate uncommitted", async () => {
    const config = structuredClone(managedConfig);
    const { run, writeConfig, prompter } = verificationFixture(config, {
      initialCandidate: authCandidate(config),
    });
    mocks.verify.mockResolvedValue({
      ok: false,
      status: "format",
      error: "inference request failed",
    });
    mocks.repair.mockRejectedValue(new Error("repair cancelled"));
    await expect(run()).rejects.toThrow("repair cancelled");
    expectNotCalled(vi.mocked(prompter.confirm), vi.mocked(prompter.select), writeConfig);
    expect(mocks.verify).toHaveBeenCalledOnce();
  });

  it("leaves verification of an existing managed route optional", async () => {
    const config = structuredClone(managedConfig);
    const { run, prompter, writeConfig } = verificationFixture(config);
    vi.mocked(prompter.confirm).mockResolvedValue(false);
    expect(await run()).toMatchObject({ attempted: false, verified: false, persisted: false });
    expect(prompter.confirm).toHaveBeenCalledOnce();
    expectNotCalled(mocks.verify, writeConfig);
  });
});
