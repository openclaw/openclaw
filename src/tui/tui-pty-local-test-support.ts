import { withTestTimeout } from "../../test/helpers/promise.js";
import type { GatewayChatClient } from "./gateway-chat.js";
import { waitFor, type PtyRun } from "./tui-pty-test-support.js";

const STARTUP_TIMEOUT_MS = 60_000;
const OUTPUT_TIMEOUT_MS = 120_000;

type CleanupRegistrar = (cleanup: () => Promise<void>) => void;

export function createIdempotentCleanup(cleanup: () => Promise<void>) {
  let cleanupPromise: Promise<void> | undefined;
  return () => (cleanupPromise ??= cleanup());
}

// Register before setup starts so a timed-out test still owns partial resources.
export function registerIdempotentCleanup(
  registerCleanup: CleanupRegistrar,
  cleanup: () => Promise<void>,
) {
  const registeredCleanup = createIdempotentCleanup(cleanup);
  registerCleanup(registeredCleanup);
  return registeredCleanup;
}

export async function startGatewayCaseControlClient(params: {
  client: GatewayChatClient;
  sessionKeys: ReadonlySet<string>;
  registerCleanup: CleanupRegistrar;
  releaseResponse: () => void;
  timeoutMs: number;
}) {
  const { client, sessionKeys, registerCleanup, releaseResponse, timeoutMs } = params;
  let connected = false;
  client.onConnected = () => {
    connected = true;
  };
  // A timed-out RPC drops its pending response while leaving the socket open.
  // Case-local ownership prevents that late work from crossing into the next test.
  const cleanup = registerIdempotentCleanup(registerCleanup, async () => {
    releaseResponse();
    try {
      if (connected) {
        await withTestTimeout(
          client.waitForReady(),
          timeoutMs,
          "Gateway case control client did not reconnect before cleanup",
        );
        for (const sessionKey of sessionKeys) {
          await client.abortChat({ sessionKey });
        }
      }
    } finally {
      await client.stop();
    }
  });
  client.start();
  await waitFor({
    timeoutMs,
    read: () => (connected ? true : null),
    onTimeout: () => new Error("Gateway case control client did not connect"),
  });
  return cleanup;
}

type ObservedChatTerminal = {
  errorMessage?: string;
  message?: unknown;
  runId: string;
  sessionKey: string;
  state: "aborted" | "error" | "final";
};

// A completed-history assertion must wait for the run's terminal event first.
// Polling history during the run can consume the RPC deadline and leak that run.
export function createChatTerminalObserver() {
  const terminals = new Map<string, ObservedChatTerminal>();
  const keyFor = (sessionKey: string, runId: string) => `${sessionKey}\u0000${runId}`;

  return {
    onEvent: ({ event, payload }: { event: string; payload?: unknown }) => {
      if (event !== "chat" || !payload || typeof payload !== "object") {
        return;
      }
      const chatEvent = payload as {
        errorMessage?: unknown;
        message?: unknown;
        runId?: unknown;
        sessionKey?: unknown;
        state?: unknown;
      };
      if (
        typeof chatEvent.runId !== "string" ||
        typeof chatEvent.sessionKey !== "string" ||
        (chatEvent.state !== "aborted" &&
          chatEvent.state !== "error" &&
          chatEvent.state !== "final")
      ) {
        return;
      }
      terminals.set(keyFor(chatEvent.sessionKey, chatEvent.runId), {
        ...(typeof chatEvent.errorMessage === "string"
          ? { errorMessage: chatEvent.errorMessage }
          : {}),
        message: chatEvent.message,
        runId: chatEvent.runId,
        sessionKey: chatEvent.sessionKey,
        state: chatEvent.state,
      });
    },
    readFinals: (sessionKey: string) =>
      [...terminals.values()].filter(
        (terminal) => terminal.sessionKey === sessionKey && terminal.state === "final",
      ),
    waitForFinal: async (params: {
      runId: string;
      sessionKey: string;
      timeoutMs: number;
      onTimeout?: () => Error;
    }) => {
      const terminal = await waitFor({
        timeoutMs: params.timeoutMs,
        read: () => terminals.get(keyFor(params.sessionKey, params.runId)) ?? null,
        onTimeout:
          params.onTimeout ??
          (() =>
            new Error(
              `chat run ${params.runId} did not reach a terminal event before history load`,
            )),
      });
      terminals.delete(keyFor(params.sessionKey, params.runId));
      if (terminal.state !== "final") {
        throw new Error(
          `chat run ${params.runId} ended as ${terminal.state}${
            terminal.errorMessage ? `: ${terminal.errorMessage}` : ""
          }`,
        );
      }
      return terminal;
    },
  };
}

export async function waitForOutputAfter(
  run: PtyRun,
  needle: string,
  offset: number,
  timeoutMs = OUTPUT_TIMEOUT_MS,
) {
  await waitFor({
    timeoutMs,
    read: () => (run.visibleOutput().slice(offset).includes(needle) ? true : null),
    onTimeout: () =>
      new Error(
        `timed out waiting for ${JSON.stringify(needle)} after offset ${offset}\n${run.output()}`,
      ),
  });
}

export function lastOutputIndexAfter(run: PtyRun, needle: string, offset: number): number {
  const relativeIndex = run.visibleOutput().slice(offset).lastIndexOf(needle);
  return relativeIndex < 0 ? -1 : offset + relativeIndex;
}

export async function createFreshSession(run: PtyRun, newSessionPrefix: string) {
  const outputOffset = run.visibleOutput().length;
  await run.write("/new\r", { delay: false });
  await waitFor({
    timeoutMs: STARTUP_TIMEOUT_MS,
    read: () => (run.visibleOutput().includes(newSessionPrefix, outputOffset) ? true : null),
    onTimeout: () =>
      new Error(`timed out creating a fresh session after one submission\n${run.output()}`),
  });
  const newSessionOffset = run.visibleOutput().lastIndexOf(newSessionPrefix);
  // Wait for the accepted session's own idle redraw; older PTY frames can
  // replay busy messages and must never cause a second session creation.
  await waitForOutputAfter(run, "| idle", newSessionOffset);
}

export async function cleanupStartedFixture(
  startup: Promise<{ cleanup: () => Promise<void> }> | undefined,
): Promise<void> {
  if (!startup) {
    return;
  }
  let fixture: { cleanup: () => Promise<void> };
  try {
    fixture = await startup;
  } catch {
    // The setup hook already reports startup failures. Teardown only owns cleanup.
    return;
  }
  await fixture.cleanup();
}
