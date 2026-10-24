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
const bindings = (
  binding: NonNullable<SessionEntry["cliSessionBindings"]>[string] = nativeBinding,
) => ({ cliSessionBindings: { "claude-cli": binding } });
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
function useBackend(config: Partial<typeof backend.config> = {}) {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [{ ...backend, config: { ...backend.config, ...config } }],
    resolvePluginSetupCliBackend: () => undefined,
  });
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

it("branches native CLI sessions with a one-shot fork resume, without mutating the parent", () => {
  const source = {
    cliSessionBindings: {
      "claude-cli": {
        ...nativeBinding,
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
  useBackend();
  const forked = forkEntry(source, {
    cliSessionIds: { "claude-cli": "stale-target" },
    claudeCliSessionId: "stale-target",
  });
  expect(forked.cliSessionBindings).toEqual({
    "claude-cli": { ...nativeBinding, forkNextResume: true },
  });
  expect(forked).toMatchObject({ cliSessionIds: undefined, claudeCliSessionId: undefined });
  expect(source.cliSessionBindings["claude-cli"]).not.toHaveProperty("forkNextResume");
});

it.each(["checkpoint", "fork support", "checkpoint resume support"])(
  "starts the child fresh without %s",
  (missing) => {
    useBackend({
      forkArg: missing === "fork support" ? undefined : "--fork-session",
      resumeAtArg: missing === "checkpoint resume support" ? undefined : "--resume-session-at",
    });
    const binding = {
      ...nativeBinding,
      resumeCheckpointId: missing === "checkpoint" ? undefined : nativeBinding.resumeCheckpointId,
    };
    expect(forkEntry(bindings(binding)).cliSessionBindings).toBeUndefined();
  },
);
