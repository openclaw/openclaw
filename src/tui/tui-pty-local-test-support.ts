import { existsSync, readFileSync } from "node:fs";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { readServiceChildMessage } from "../process/supervisor/service-child-protocol.js";
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

export function createLocalShellControlFloodPreload() {
  return `
    const fs = require("node:fs");
    const path = require("node:path");
    const { Socket } = require("node:net");
    const role = /service-child-(relay|group-anchor)\\.[cm]?[jt]s$/.exec(process.argv[1] || "")?.[1];
    const pidPath = process.env.OPENCLAW_CONTROL_PROBE_PATH;
    if (role) fs.appendFileSync(pidPath, role + " " + process.pid + "\\n");
    const originalWrite = Socket.prototype.write;
    let armed = false;
    Socket.prototype.write = function (chunk, ...args) {
      const text = String(chunk);
      if (armed || role !== "group-anchor" || !text.includes('"type":"ready"')) {
        return originalWrite.call(this, chunk, ...args);
      }
      armed = true;
      const ready = JSON.parse(text);
      const releasePath = pidPath + ".release";
      let released = false;
      const release = () => {
        if (released || !fs.existsSync(releasePath)) return;
        released = true;
        watcher.close();
        originalWrite.call(this, "é".repeat(131_073) + "\\n");
      };
      const watcher = fs.watch(path.dirname(releasePath), release);
      this.once("close", () => watcher.close());
      const accepted = originalWrite.call(this, chunk, ...args);
      fs.appendFileSync(pidPath, "root " + ready.commandPid + "\\n");
      // Publish the genuine owner receipt only after the release observer is armed.
      fs.writeFileSync(pidPath + ".ready.tmp", text);
      fs.renameSync(pidPath + ".ready.tmp", pidPath + ".ready");
      release();
      return accepted;
    };
  `;
}

export function readLocalShellControlFloodPids(rolePidPath: string, commandPidPath: string) {
  const readyPath = `${rolePidPath}.ready`;
  if (![rolePidPath, commandPidPath, readyPath].every(existsSync)) {
    return null;
  }
  const ready = readServiceChildMessage(JSON.parse(readFileSync(readyPath, "utf8")));
  if (ready.type !== "ready") {
    throw new Error("unexpected local shell process ownership receipt");
  }
  const expectedRoles = ["group-anchor", "root", "command", "descendant"];
  if (ready.treeOwnership !== "linux-subreaper") {
    expectedRoles.push("relay");
  }
  const entries = new Map<string, number>();
  const records = [rolePidPath, commandPidPath].map((file) => readFileSync(file, "utf8"));
  // The command writes both rows after its descendant's IPC-ready acknowledgement.
  // Do not consume a partial write as a complete process ownership receipt.
  if (records.some((record) => !record.endsWith("\n"))) {
    return null;
  }
  for (const line of records.join("").trim().split("\n")) {
    const match = /^(relay|group-anchor|root|command|descendant) (\d+)$/u.exec(line);
    const pid = Number(match?.[2]);
    if (!match?.[1] || !Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error(`unexpected control-flood PID line: ${JSON.stringify(line)}`);
    }
    const role = match[1];
    if (!expectedRoles.includes(role) || (entries.has(role) && entries.get(role) !== pid)) {
      throw new Error(`unexpected or conflicting control-flood process role: ${role}`);
    }
    entries.set(role, pid);
  }
  if (entries.size !== expectedRoles.length || !expectedRoles.every((role) => entries.has(role))) {
    return null;
  }
  if (entries.get("group-anchor") !== ready.anchorPid || entries.get("root") !== ready.commandPid) {
    throw new Error("control-flood PID receipt does not match its live anchor");
  }
  return entries;
}
