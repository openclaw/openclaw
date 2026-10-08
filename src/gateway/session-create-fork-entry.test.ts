import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { getContextWindowCaches, providerContextTokenCacheKey } from "../agents/context-cache.js";
import { resetContextWindowCacheForTest } from "../agents/context.test-support.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { buildForkedGatewaySessionEntry } from "./session-create-fork-entry.js";
import { resolveSessionForkMaxTokens } from "./session-create-model-selection.js";

const forkableClaudeCliBackend = {
  id: "claude-cli",
  pluginId: "anthropic",
  modelProvider: "anthropic",
  config: { command: "claude", forkArg: "--fork-session", resumeAtArg: "--resume-session-at" },
  bundleMcp: false,
  ownsNativeCompaction: false,
} satisfies ReturnType<
  (typeof import("../plugins/cli-backends.runtime.js"))["resolveRuntimeCliBackends"]
>[number];

beforeEach(() => {
  resetContextWindowCacheForTest();
});

afterEach(() => {
  resetContextWindowCacheForTest();
  cliBackendsTesting.resetDepsForTest();
});

describe("buildForkedGatewaySessionEntry", () => {
  it("preserves adopted node ancestry and links the replaced generation", () => {
    const previous: SessionEntry = {
      sessionId: "adopted-generation",
      updatedAt: 1,
      lifecycleRunId: "adopted-run",
      lastRunId: "settled-adopted-run",
      forkSource: { sessionKey: "agent:main:original", sessionId: "original-generation" },
    };

    const forked = buildForkedGatewaySessionEntry(
      previous,
      { sessionId: "next-generation", sessionFile: "/tmp/next-generation.jsonl" },
      {
        sessionKey: "agent:main:new-parent",
        entry: { sessionId: "new-parent-generation", updatedAt: 1 },
      },
      previous,
    );

    expect(forked).toMatchObject({
      sessionId: "next-generation",
      previousSessionId: "adopted-generation",
      forkSource: { sessionKey: "agent:main:original", sessionId: "original-generation" },
    });
    expect(forked.lifecycleRunId).toBeUndefined();
    expect(forked.lastRunId).toBeUndefined();
  });

  it("uses the requested ancestry for a genuinely new node", () => {
    const entry: SessionEntry = { sessionId: "provisional", updatedAt: 1 };
    const forked = buildForkedGatewaySessionEntry(
      entry,
      { sessionId: "forked", sessionFile: "/tmp/forked.jsonl" },
      {
        sessionKey: "agent:main:parent",
        entry: { sessionId: "parent-generation", updatedAt: 1 },
      },
    );

    expect(forked.forkSource).toEqual({
      sessionKey: "agent:main:parent",
      sessionId: "parent-generation",
    });
    expect(forked.previousSessionId).toBeUndefined();
  });

  it("branches the parent native CLI sessions into the child with a one-shot fork resume", () => {
    const parent: SessionEntry = {
      sessionId: "parent-generation",
      updatedAt: 1,
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "native-parent",
          cwdHash: "cwd",
          resumeCheckpointId: "parent-checkpoint",
          forceReuse: true,
          reseedReceipt: {
            version: 1,
            promptHash: "a".repeat(64),
            localSessionId: "parent-generation",
            userTurnDisposition: "omitted",
          },
        },
      },
      cliSessionIds: { "codex-cli": "codex-parent" },
    };
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [forkableClaudeCliBackend],
      resolvePluginSetupCliBackend: () => undefined,
    });
    const forked = buildForkedGatewaySessionEntry(
      {
        sessionId: "provisional",
        updatedAt: 1,
        cliSessionIds: { "claude-cli": "stale-target" },
        claudeCliSessionId: "stale-target",
      },
      { sessionId: "forked", sessionFile: "/tmp/forked.jsonl" },
      { sessionKey: "agent:main:parent", entry: parent },
    );

    expect(forked.cliSessionBindings).toEqual({
      "claude-cli": {
        sessionId: "native-parent",
        cwdHash: "cwd",
        resumeCheckpointId: "parent-checkpoint",
        forkNextResume: true,
      },
    });
    expect(forked.cliSessionIds).toBeUndefined();
    expect(forked.claudeCliSessionId).toBeUndefined();
    expect(parent.cliSessionBindings?.["claude-cli"]?.forkNextResume).toBeUndefined();
  });

  it.each(["checkpoint", "fork support", "checkpoint resume support"])(
    "starts the child fresh without %s",
    (missing) => {
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [
          {
            ...forkableClaudeCliBackend,
            config: {
              ...forkableClaudeCliBackend.config,
              forkArg: missing === "fork support" ? undefined : "--fork-session",
              resumeAtArg:
                missing === "checkpoint resume support" ? undefined : "--resume-session-at",
            },
          },
        ],
        resolvePluginSetupCliBackend: () => undefined,
      });
      const forked = buildForkedGatewaySessionEntry(
        { sessionId: "provisional", updatedAt: 1 },
        { sessionId: "forked", sessionFile: "/tmp/forked.jsonl" },
        {
          sessionKey: "agent:main:parent",
          entry: {
            sessionId: "parent-generation",
            updatedAt: 1,
            cliSessionBindings: {
              "claude-cli": {
                sessionId: "native-parent",
                cwdHash: "cwd",
                ...(missing === "checkpoint" ? {} : { resumeCheckpointId: "parent-checkpoint" }),
              },
            },
          },
        },
      );

      // Both capabilities and a recorded checkpoint are required for an isolated stable branch.
      expect(forked.cliSessionBindings).toBeUndefined();
    },
  );
});

describe("Gateway fork capacity", () => {
  it.each([
    {
      name: "native synthetic window",
      runtime: "codex",
      window: 128_000,
      synthetic: true,
      prompt: undefined,
      expected: 128_000,
    },
    {
      name: "native genuine window",
      runtime: "codex",
      window: 64_000,
      synthetic: false,
      prompt: undefined,
      expected: 64_000,
    },
    {
      name: "native reported prompt beside synthetic window",
      runtime: "codex",
      window: 128_000,
      synthetic: true,
      prompt: 777_000,
      expected: 777_000,
    },
    {
      name: "missing native capacity beside API inventory",
      runtime: "codex",
      window: undefined,
      synthetic: false,
      prompt: undefined,
      expected: undefined,
    },
    {
      name: "API capacity",
      runtime: "openclaw",
      window: undefined,
      synthetic: false,
      prompt: undefined,
      expected: 1_000_000,
    },
  ])(
    "uses $name without borrowing a warm API budget",
    async ({ runtime, window, synthetic, prompt, expected }) => {
      const provider = "openai";
      const model = "fork-capacity-fixture";
      const entry: SessionEntry = {
        sessionId: "fork-capacity-child",
        updatedAt: 1,
        modelProvider: provider,
        model,
        providerOverride: provider,
        modelOverride: model,
        agentRuntimeOverride: runtime,
        agentHarnessId: "previous-native-runtime",
      };
      const api: ModelCatalogEntry = {
        provider,
        id: model,
        name: "Fork fixture",
        contextWindow: 1_000_000,
      };
      const native: ModelCatalogEntry | undefined =
        window === undefined
          ? undefined
          : {
              provider,
              id: model,
              name: "Native fork fixture",
              nativeRuntime: "codex",
              contextWindow: window,
              ...(synthetic ? { contextWindowSource: "synthetic" } : {}),
              ...(prompt === undefined ? {} : { contextTokens: prompt }),
            };
      const cfg = {};
      const sessionKey = "agent:main:fork-capacity";
      expect(resolveSessionModelRef(cfg, entry, "main")).toEqual({ provider, model });
      expect(
        resolveEffectiveAgentRuntime({
          cfg,
          agentId: "main",
          provider,
          modelId: model,
          sessionKey,
          sessionEntry: entry,
        }),
      ).toBe(runtime);
      getContextWindowCaches().discoveredTokenCache.set(
        providerContextTokenCacheKey(provider, model),
        1_000_000,
      );
      expect(
        await resolveSessionForkMaxTokens({
          cfg,
          agentId: "main",
          sessionKey,
          entry,
          loadGatewayModelCatalogSnapshot: async () => ({
            entries: [api],
            routeVariants: native ? [api, native] : [api],
          }),
        }),
      ).toBe(expected);
    },
  );
});
