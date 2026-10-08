import path from "node:path";
import { expect, it } from "vitest";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { createSessionHistoryWorkerReaders } from "./session-transcript-worker-readers.js";

it("preserves the direct read request, signal, and projected result", async () => {
  const input = { scope: { agentId: "main", sessionId: "synthetic-session" } };
  const signal = new AbortController().signal;
  const readers = createSessionHistoryWorkerReaders(
    async (prepare, inputBytes, receive, receivedSignal) => {
      expect(prepare()).toEqual({ kind: "transcript-message-presence", ...input });
      expect(inputBytes).toBe(JSON.stringify(input).length * 2);
      expect(receivedSignal).toBe(signal);
      return receive({ kind: "transcript-message-presence", present: true });
    },
  );
  await expect(readers.readMessagePresence(input, signal)).resolves.toBe(true);
});

it.each([
  { value: false },
  { value: { kind: "session-members" as const, entry: undefined, members: [] } },
  { value: { kind: "prewarm" as const } },
])("rejects another worker result before projecting it: %j", async ({ value }) => {
  const readers = createSessionHistoryWorkerReaders(async (_prepare, _inputBytes, receive) =>
    receive(value),
  );
  await expect(
    readers.readMessagePresence({ scope: { sessionId: "synthetic-session" } }),
  ).rejects.toThrow("Session history worker returned another result instead of message presence");
});

it.each(["archives", "corpus", "targets"] as const)(
  "serializes Windows storage environments for %s inventory",
  async (inventory) => {
    const stateDir = path.resolve("synthetic-state");
    const storePath = path.join(stateDir, "sessions.sqlite");
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const env = cloneEnvWithPlatformSemantics({
        openclaw_state_dir: stateDir,
        OpenClaw_Supervisor_Mode: "external",
        UNRELATED_VALUE: "synthetic",
      });
      const readers = createSessionHistoryWorkerReaders(async (prepare, _inputBytes, receive) => {
        // postMessage uses this same clone contract before a worker can consume the request.
        const request = structuredClone(prepare());
        const expectedEnv = {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_SUPERVISOR_MODE: "external",
        };
        switch (request.kind) {
          case "session-archive-inventory":
            expect(request.env).toEqual(expectedEnv);
            return receive({ kind: request.kind, archives: [] });
          case "session-corpus-inventory":
            expect(request.scope.env).toEqual(expectedEnv);
            return receive({ kind: request.kind, entries: [] });
          case "memory-session-targets":
            expect(request.params.env).toEqual(expectedEnv);
            return receive({ kind: request.kind, targets: [] });
          default:
            throw new Error(`Unexpected inventory request: ${request.kind}`);
        }
      });
      const result =
        inventory === "archives"
          ? readers.readArchiveInventory({ agentId: "main", storePath, env, sessionIds: ["one"] })
          : inventory === "targets"
            ? readers.readMemorySessionTargets({
                params: { agentId: "main", storePath, env, sessionIds: ["one"] },
              })
            : readers.readCorpusInventory({
                scope: {
                  cfg: {},
                  normalizedAgentId: "main",
                  storePath,
                  env,
                  artifactDirs: [],
                  isSharedFixedStore: false,
                },
                options: {},
                artifacts: [],
              });
      await expect(result).resolves.toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
  },
);
