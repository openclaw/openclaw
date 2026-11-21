import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  cleanupStartedFixture,
  createChatTerminalObserver,
  createFreshSession,
  registerIdempotentCleanup,
} from "./tui-pty-local-test-support.js";
import type { PtyRun } from "./tui-pty-test-support.js";

const observedRun = { runId: "run-history", sessionKey: "agent:main:history", timeoutMs: 1_000 };
function chatEvent(state: string, fields = {}) {
  const { runId, sessionKey } = observedRun;
  return { event: "chat", payload: { runId, sessionKey, state, ...fields } };
}

it("registers cleanup synchronously and runs it only once", async () => {
  const order: string[] = [];
  let registeredCleanup: (() => Promise<void>) | undefined;
  const cleanup = registerIdempotentCleanup(
    (registered) => {
      order.push("registered");
      registeredCleanup = registered;
    },
    async () => {
      order.push("cleanup");
    },
  );
  expect(registeredCleanup).toBe(cleanup);
  await cleanup();
  await registeredCleanup!();
  expect(order).toEqual(["registered", "cleanup"]);
});

it("waits for the matching successful terminal event before history observation", async () => {
  const observer = createChatTerminalObserver();
  const terminal = observer.waitForFinal(observedRun);
  observer.onEvent(chatEvent("delta"));
  observer.onEvent(chatEvent("final", { runId: "run-other" }));
  observer.onEvent(chatEvent("final"));

  await expect(terminal).resolves.toMatchObject({ state: "final" });
});

it("fails promptly when the observed chat run terminates with an error", async () => {
  const observer = createChatTerminalObserver();
  observer.onEvent(chatEvent("error", { errorMessage: "provider failed" }));

  await expect(observer.waitForFinal(observedRun)).rejects.toThrow(
    "chat run run-history ended as error: provider failed",
  );
});

it("owns late fixture startup without swallowing cleanup failures", async () => {
  await expect(cleanupStartedFixture(Promise.reject(new Error("setup failed")))).resolves.toBe(
    undefined,
  );

  const cleanupError = new Error("cleanup failed");
  const fixture = {
    cleanup: async () => {
      throw cleanupError;
    },
  };
  await expect(cleanupStartedFixture(Promise.resolve(fixture))).rejects.toBe(cleanupError);
});

it("does not replay a session rollover when an old busy notice is redrawn", async () => {
  const newSessionPrefix = "new session: agent:main:tui-";
  const acceptedSession = createDeferred();
  const writes: string[] = [];
  let output = "";
  let acceptanceTimer: ReturnType<typeof setTimeout> | undefined;
  const run = {
    cols: 100,
    exited: new Promise<never>(() => {}),
    onOutput: () => () => {},
    output: () => output,
    pid: 123,
    rows: 30,
    visibleOutput: () => output.replace(/\s+/gu, " "),
    write: async (data: string) => {
      writes.push(data);
      if (writes.length === 1) {
        output += "abort the current run before /new\n";
        acceptanceTimer = setTimeout(() => {
          output += `${newSessionPrefix}accepted\nlocal ready | idle\n`;
          acceptedSession.resolve();
        }, 200);
        return;
      }
      output += `${newSessionPrefix}duplicate\nlocal ready | idle\n`;
    },
    waitForOutput: async () => output,
    waitForExit: async () => ({ exitCode: 0, signal: 0 }),
    forceKill: async () => {},
    dispose: async () => {},
  } satisfies PtyRun;

  try {
    await createFreshSession(run, newSessionPrefix);
    await acceptedSession.promise;
    expect(writes).toEqual(["/new\r"]);
  } finally {
    if (acceptanceTimer) {
      clearTimeout(acceptanceTimer);
    }
  }
});
