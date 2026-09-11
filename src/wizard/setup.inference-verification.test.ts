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
import type { ActivateSetupInferenceDeps } from "../system-agent/setup-inference-core.js";
import { verifySetupInferenceConfig } from "../system-agent/setup-inference-turn.js";
import type { WizardPrompter } from "./prompts.js";
import type { SetupModelAuthCandidate } from "./setup.model-auth.js";

const mocks = vi.hoisted(() => ({
  repair: vi.fn(),
  verify: vi.fn(),
  runEmbedded: vi.fn<NonNullable<ActivateSetupInferenceDeps["runEmbeddedAgent"]>>(),
}));

vi.mock("../system-agent/setup-inference.js", () => ({
  verifySetupInferenceConfig: mocks.verify,
}));
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.runEmbedded }));
vi.mock("./setup.model-auth.js", () => ({
  runSetupModelAuthStep: mocks.repair,
}));

import { offerLiveModelVerification } from "./setup.inference-verification.js";

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
        entries: { main: { default: true } },
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
      workspaceDir: stateDir,
      stateDir,
      agentDir,
      writeConfig,
      required: true,
    };
    try {
      await expect(offerLiveModelVerification(params)).resolves.toMatchObject({
        verified: false,
        persisted: false,
      });
      await expect(offerLiveModelVerification(params)).resolves.toMatchObject({
        verified: false,
        persisted: false,
      });
      expect(attemptedProfiles).toHaveLength(2);
      expect(attemptedProfiles[1]).toBe(attemptedProfiles[0]);
      expect(Object.keys(readAuthProfileStoreForTest(agentDir).profiles)).toHaveLength(2);
      expect(persistAuthProfiles).toHaveBeenCalledOnce();
      expect(writeConfig).not.toHaveBeenCalled();
      expect(config).toEqual(before);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it.each<{
    label: string;
    roster: NonNullable<OpenClawConfig["agents"]>;
    owner: string | undefined;
    harness: "codex" | "openclaw" | undefined;
  }>([
    { label: "missing legacy roster", roster: {}, owner: "main", harness: undefined },
    { label: "empty legacy roster", roster: { entries: {} }, owner: "main", harness: "openclaw" },
    {
      label: "named explicit owner",
      roster: { ownership: "explicit", entries: { research: {} } },
      owner: "research",
      harness: "codex",
    },
    {
      label: "legacy named owner",
      roster: { entries: { research: { default: true }, other: {} } },
      owner: "research",
      harness: "openclaw",
    },
    {
      label: "empty explicit roster",
      roster: { ownership: "explicit", entries: {} },
      owner: undefined,
      harness: undefined,
    },
  ])("keeps $label runtime-only during verification", async ({ roster, owner, harness }) => {
    const root = await fs.realpath(tempRoots.make("openclaw-staged-verification-"));
    const config: OpenClawConfig = {
      agents: {
        ...roster,
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
      expect(params.agentDir).toBe(agentDir);
      expect(params.provider).toBe("openai");
      expect(params.model).toBe("gpt-5.6-luna");
      expect(params.agentHarnessRuntimeOverride).toBe(harness);
      expect(params.authProfileStateMode).toBe("read-only");
      expect(params.sessionKey).toMatch(new RegExp(`^agent:${owner}:setup-inference:`));
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
      verifySetupInferenceConfig({ ...params, deps: { ...params.deps, runEmbeddedAgent } }),
    );
    const writeConfig = vi.fn(async (next: OpenClawConfig) => next);
    const persistAuthProfiles = vi.fn(async () => {});
    const verification = offerLiveModelVerification({
      config,
      initialCandidate: { config, authProfiles: [], persistAuthProfiles },
      opts: { nonInteractive: true },
      prompter: createPrompter(),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      workspaceDir: root,
      agentDir,
      stateDir: root,
      writeConfig,
      required: true,
    });
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
      expect(writeConfig).not.toHaveBeenCalled();
      expect(persistAuthProfiles).not.toHaveBeenCalled();
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    }
    expect(config).toEqual(before);
  });

  it("does not enter interactive repair for a failed noninteractive import", async () => {
    mocks.verify.mockResolvedValue({ ok: false, status: "auth", error: "credential expired" });
    const select = vi.fn();
    const prompter = { ...createPrompter(), select };

    await expect(
      offerLiveModelVerification({
        config: { agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } } },
        opts: { nonInteractive: true },
        prompter,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
        workspaceDir: "/tmp/openclaw-test-workspace",
        writeConfig: async (config) => config,
        required: true,
      }),
    ).resolves.toEqual({
      config: { agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } } },
      attempted: true,
      persisted: false,
      verified: false,
    });

    expect(select).not.toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("stops verification progress when the provider check rejects", async () => {
    const verificationError = new Error("provider network dropped");
    mocks.verify.mockRejectedValue(verificationError);
    const stop = vi.fn();
    const prompter = {
      ...createPrompter(),
      progress: vi.fn(() => ({ stop, update: vi.fn() })),
    };

    await expect(
      offerLiveModelVerification({
        config: { agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } } },
        opts: { nonInteractive: true },
        prompter,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
        workspaceDir: "/tmp/openclaw-test-workspace",
        writeConfig: async (config) => config,
        required: true,
      }),
    ).rejects.toBe(verificationError);

    expect(stop).toHaveBeenCalledOnce();
    expect(prompter.note).not.toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("reports when a repair candidate persisted its verified config", async () => {
    const repairedConfig: OpenClawConfig = {
      agents: { entries: { main: { default: true } } },
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
      offerLiveModelVerification({
        config: { agents: { entries: { main: { default: true } } } },
        opts: {},
        prompter,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
        workspaceDir: "/tmp/openclaw-test-workspace",
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
      offerLiveModelVerification({
        config,
        initialCandidate: { config, authProfiles: [], persistAuthProfiles },
        opts: {},
        prompter,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        workspaceDir: "/tmp/openclaw-test-workspace",
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
      await offerLiveModelVerification({
        config,
        opts: {},
        prompter,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        workspaceDir: "/tmp/openclaw-test-workspace",
        writeConfig,
      }),
    ).toMatchObject({ attempted: false, verified: false, persisted: false });
    expect(prompter.confirm).toHaveBeenCalledOnce();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });
});
