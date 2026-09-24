import { afterEach, describe, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { buildForkedGatewaySessionEntry } from "./session-create-fork-entry.js";

const forkableClaudeCliBackend = {
  id: "claude-cli",
  pluginId: "anthropic",
  modelProvider: "anthropic",
  config: { command: "claude", forkArg: "--fork-session" },
  bundleMcp: false,
  ownsNativeCompaction: false,
} as unknown as ReturnType<
  (typeof import("../plugins/cli-backends.runtime.js"))["resolveRuntimeCliBackends"]
>[number];

afterEach(() => {
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
      { sessionKey: "agent:main:new-parent", sessionId: "new-parent-generation" },
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
      { sessionKey: "agent:main:parent", sessionId: "parent-generation" },
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
      { sessionKey: "agent:main:parent", sessionId: "parent-generation" },
      undefined,
      parent,
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

  it("starts the child fresh when the parent native session has no checkpoint", () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [forkableClaudeCliBackend],
      resolvePluginSetupCliBackend: () => undefined,
    });
    const forked = buildForkedGatewaySessionEntry(
      { sessionId: "provisional", updatedAt: 1 },
      { sessionId: "forked", sessionFile: "/tmp/forked.jsonl" },
      { sessionKey: "agent:main:parent", sessionId: "parent-generation" },
      undefined,
      {
        sessionId: "parent-generation",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: "native-parent", cwdHash: "cwd" } },
      },
    );

    // Without a checkpoint the fork has no stable cutoff, so the child starts a fresh session.
    expect(forked.cliSessionBindings).toBeUndefined();
  });
});
