import { afterEach, describe, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { buildForkedGatewaySessionEntry } from "./session-create-fork-entry.js";

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

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
});

const entry = (sessionId: string, overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId,
  updatedAt: 1,
  ...overrides,
});
const fork = { sessionId: "forked", sessionFile: "/tmp/forked.jsonl" };
const nativeBinding = {
  sessionId: "native-parent",
  cwdHash: "cwd",
  resumeCheckpointId: "parent-checkpoint",
};
const parent = (parentEntry = entry("parent-generation"), sessionKey = "agent:main:parent") => ({
  sessionKey,
  entry: parentEntry,
});
function useBackend(config: Partial<typeof forkableClaudeCliBackend.config> = {}) {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      { ...forkableClaudeCliBackend, config: { ...forkableClaudeCliBackend.config, ...config } },
    ],
    resolvePluginSetupCliBackend: () => undefined,
  });
}

describe("buildForkedGatewaySessionEntry", () => {
  it("preserves adopted node ancestry and links the replaced generation", () => {
    const previous = entry("adopted-generation", {
      lifecycleRunId: "adopted-run",
      lastRunId: "settled-adopted-run",
      forkSource: { sessionKey: "agent:main:original", sessionId: "original-generation" },
    });

    const forked = buildForkedGatewaySessionEntry(
      previous,
      { sessionId: "next-generation", sessionFile: "/tmp/next-generation.jsonl" },
      parent(entry("new-parent-generation"), "agent:main:new-parent"),
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
    const forked = buildForkedGatewaySessionEntry(entry("provisional"), fork, parent());

    expect(forked.forkSource).toEqual({
      sessionKey: "agent:main:parent",
      sessionId: "parent-generation",
    });
    expect(forked.previousSessionId).toBeUndefined();
  });

  it("branches the parent native CLI sessions into the child with a one-shot fork resume", () => {
    const parentEntry = entry("parent-generation", {
      cliSessionBindings: {
        "claude-cli": {
          ...nativeBinding,
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
    });
    useBackend();
    const forked = buildForkedGatewaySessionEntry(
      entry("provisional", {
        cliSessionIds: { "claude-cli": "stale-target" },
        claudeCliSessionId: "stale-target",
      }),
      fork,
      parent(parentEntry),
    );

    expect(forked.cliSessionBindings).toEqual({
      "claude-cli": {
        ...nativeBinding,
        forkNextResume: true,
      },
    });
    expect(forked.cliSessionIds).toBeUndefined();
    expect(forked.claudeCliSessionId).toBeUndefined();
    expect(parentEntry.cliSessionBindings?.["claude-cli"]?.forkNextResume).toBeUndefined();
  });

  it.each(["checkpoint", "fork support", "checkpoint resume support"])(
    "starts the child fresh without %s",
    (missing) => {
      useBackend({
        forkArg: missing === "fork support" ? undefined : "--fork-session",
        resumeAtArg: missing === "checkpoint resume support" ? undefined : "--resume-session-at",
      });
      const forked = buildForkedGatewaySessionEntry(
        entry("provisional"),
        fork,
        parent(
          entry("parent-generation", {
            cliSessionBindings: {
              "claude-cli": {
                ...nativeBinding,
                resumeCheckpointId:
                  missing === "checkpoint" ? undefined : nativeBinding.resumeCheckpointId,
              },
            },
          }),
        ),
      );

      expect(forked.cliSessionBindings).toBeUndefined();
    },
  );
});
