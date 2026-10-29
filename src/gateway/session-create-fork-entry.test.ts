import { afterEach, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { buildForkedGatewaySessionEntry } from "./session-create-fork-entry.js";

const backend = {
  id: "claude-cli",
  pluginId: "anthropic",
  modelProvider: "anthropic",
  config: { command: "claude", forkArg: "--fork-session", resumeAtArg: "--resume-session-at" },
  bundleMcp: false,
  ownsNativeCompaction: false,
} satisfies ReturnType<
  (typeof import("../plugins/cli-backends.runtime.js"))["resolveRuntimeCliBackends"]
>[number];
const nativeBinding = {
  sessionId: "native-parent",
  cwdHash: "cwd",
  resumeCheckpointId: "checkpoint",
};
const entry = (sessionId: string, overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId,
  updatedAt: 1,
  ...overrides,
});
function forkEntry(
  source: Partial<SessionEntry> = {},
  target: Partial<SessionEntry> = {},
  previous?: SessionEntry,
) {
  return buildForkedGatewaySessionEntry(
    entry("provisional", target),
    { sessionId: "forked", sessionFile: "/tmp/forked.jsonl" },
    { sessionKey: "agent:main:parent", entry: entry("parent-generation", source) },
    previous,
  );
}
afterEach(() => cliBackendsTesting.resetDepsForTest());

it.each([false, true])("preserves ancestry when replacing an adopted node: %s", (adopted) => {
  const previous = adopted
    ? entry("adopted", {
        lifecycleRunId: "adopted-run",
        lastRunId: "settled-run",
        forkSource: { sessionKey: "agent:main:original", sessionId: "original-generation" },
      })
    : undefined;
  const forked = forkEntry({}, previous, previous);
  expect(forked).toMatchObject({
    sessionId: "forked",
    lifecycleRunId: undefined,
    lastRunId: undefined,
  });
  expect(forked.previousSessionId).toBe(adopted ? "adopted" : undefined);
  expect(forked.forkSource).toEqual(
    adopted
      ? { sessionKey: "agent:main:original", sessionId: "original-generation" }
      : { sessionKey: "agent:main:parent", sessionId: "parent-generation" },
  );
});

it.each([undefined, "checkpoint", "forkArg", "resumeAtArg"] as const)(
  "branches native CLI sessions without mutating the parent (missing: %s)",
  (missing) => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          ...backend,
          config: {
            ...backend.config,
            ...(missing && missing !== "checkpoint" ? { [missing]: undefined } : {}),
          },
        },
      ],
      resolvePluginSetupCliBackend: () => undefined,
    });
    const source = {
      cliSessionBindings: {
        "claude-cli": {
          ...nativeBinding,
          resumeCheckpointId:
            missing === "checkpoint" ? undefined : nativeBinding.resumeCheckpointId,
          forceReuse: true,
          reseedReceipt: {
            version: 1 as const,
            promptHash: "a".repeat(64),
            localSessionId: "parent-generation",
            userTurnDisposition: "omitted" as const,
          },
        },
      },
      cliSessionIds: { "codex-cli": "codex-parent" },
    };
    const forked = forkEntry(source, {
      cliSessionIds: { "claude-cli": "stale-target" },
      claudeCliSessionId: "stale-target",
    });
    const expected = missing
      ? undefined
      : { "claude-cli": { ...nativeBinding, forkNextResume: true } };
    expect(forked.cliSessionBindings).toEqual(expected);
    expect(forked).toMatchObject({ cliSessionIds: undefined, claudeCliSessionId: undefined });
    expect(source.cliSessionBindings["claude-cli"]).not.toHaveProperty("forkNextResume");
  },
);
