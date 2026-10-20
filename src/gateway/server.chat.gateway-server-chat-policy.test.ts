import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import * as harnessRegistry from "../agents/harness/registry.js";
import { loadSessionEntry, updateSessionEntry } from "../config/sessions/session-accessor.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { installGatewayServerChatTestSuite } from "./server.chat.gateway-server-chat.test-support.js";
import { collectHistoryTextValues } from "./session-history-fixtures.test-support.js";
import {
  connectOk,
  dispatchInboundMessageMock,
  mockGetReplyFromConfigOnce,
  onceMessage,
  rpcReq,
  testState,
  trackConnectChallengeNonce,
} from "./test-helpers.js";
import { agentCommandMock } from "./test-helpers.runtime-state.js";

let ws: WebSocket;
let port: number;

const connectWork: Promise<unknown>[] = [];
let joinedConnectWork = 0;
let restoreConnectWork: (() => void) | undefined;

const waitForConnectWork = async () => {
  while (joinedConnectWork < connectWork.length) {
    // A producer can register catalog tails before releasing its own root.
    const pending = connectWork.slice(joinedConnectWork);
    joinedConnectWork = connectWork.length;
    await Promise.allSettled(pending);
  }
};

// Install before this suite opens either socket; delegate all admission to its real owner.
beforeAll(async () => {
  const admission = await import("../process/gateway-work-admission.js");
  const beginRoot = admission.tryBeginGatewayRootWorkAdmission;
  const runIndependent = admission.runWithGatewayIndependentRootWorkAdmission;
  const producers = vi
    .spyOn(admission, "tryBeginGatewayRootWorkAdmission")
    .mockImplementation((origin) => {
      const lease = beginRoot(origin);
      // Handler completion can precede release of retained request work.
      return lease && (origin === "ws:connect" || origin === "ws:chat.send")
        ? {
            ...lease,
            run: (run) =>
              lease.run(() => {
                const released = createDeferred<"settled" | "reset">();
                const observeRelease = admission.captureGatewayRootWorkReleaseObserver();
                if (!observeRelease) {
                  throw new Error("connect producer must retain its admitted root");
                }
                observeRelease(released.resolve);
                connectWork.push(released.promise);
                return run();
              }),
          }
        : lease;
    });
  const tails = vi
    .spyOn(admission, "runWithGatewayIndependentRootWorkAdmission")
    .mockImplementation((run, origin, signal) => {
      const pending = runIndependent(run, origin, signal);
      if (origin === "ws:preauth") {
        connectWork.push(pending);
      }
      return pending;
    });
  restoreConnectWork = () => {
    tails.mockRestore();
    producers.mockRestore();
  };
});
beforeEach(waitForConnectWork);
afterAll(async () => {
  try {
    await waitForConnectWork();
  } finally {
    restoreConnectWork?.();
  }
});

const gatewaySuite = installGatewayServerChatTestSuite((started) => {
  ws = started.ws;
  port = started.port;
}, waitForConnectWork);
const {
  abortChatRun,
  expectAgentWaitTimeout,
  mockBlockedChatReply,
  sendChatAndExpectStarted,
  settleGatewayFixture,
  waitForAgentRunDrained,
  withMainSessionStore,
} = gatewaySuite;

function sessionEntry(sessionKey = "agent:main:main") {
  const storePath = testState.sessionStorePath;
  if (!storePath) {
    throw new Error("session store path was not initialized");
  }
  return loadSessionEntry({ sessionKey, storePath });
}

async function withOperator(scopes: string[], run: (socket: WebSocket) => Promise<void>) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(socket);
  try {
    await new Promise<void>((resolve) => {
      socket.once("open", resolve);
    });
    await connectOk(socket, { scopes });
    await run(socket);
  } finally {
    socket.close();
  }
}

async function useRealReply() {
  const { getReplyFromConfig } = await import("../auto-reply/reply/get-reply.js");
  const { withFullRuntimeReplyConfig } = await import("../auto-reply/reply/get-reply-fast-path.js");
  mockGetReplyFromConfigOnce((ctx, opts, cfg) =>
    getReplyFromConfig(ctx, opts, cfg ? withFullRuntimeReplyConfig(cfg) : cfg),
  );
}

async function sendUntilTerminal(
  socket: WebSocket,
  runId: string,
  message: string,
  states: string[],
) {
  const terminal = onceMessage(
    socket,
    (event) =>
      event.type === "event" &&
      event.event === "chat" &&
      event.payload?.runId === runId &&
      typeof event.payload?.state === "string" &&
      states.includes(event.payload?.state),
  );
  const [sent, settled] = await Promise.all([
    rpcReq(socket, "chat.send", { sessionKey: "main", message, idempotencyKey: runId }),
    terminal,
  ]);
  expect(sent.ok).toBe(true);
  return { sent, settled };
}

async function history(socket: WebSocket) {
  const response = await rpcReq<{
    sessionId?: string;
    messages?: Array<{ role?: string; content?: unknown }>;
  }>(socket, "chat.history", { sessionKey: "main" });
  expect(response.ok).toBe(true);
  return response.payload;
}

const waitForRun = (socket: WebSocket, runId: string, timeoutMs = 1_000) =>
  rpcReq(socket, "agent.wait", { runId, timeoutMs });
async function startAgent(runId: string, sessionKey = "main") {
  expect(
    await rpcReq(ws, "agent", { sessionKey, message: "hold this run open", idempotencyKey: runId }),
  ).toMatchObject({ ok: true, payload: { status: "accepted" } });
}

test("fixture cleanup joins the exact retained chat.send root", async () => {
  const admission = await import("../process/gateway-work-admission.js");
  const lease = admission.tryBeginGatewayRootWorkAdmission("ws:chat.send");
  if (!lease) {
    throw new Error("Expected admitted request fixture");
  }
  const release = createDeferred();
  let retained: Promise<unknown> | undefined;
  let joined: Promise<void> | undefined;
  let settled = false;
  try {
    await lease.run(async () => {
      retained = admission.runWithRetainedGatewayRootWork(() => release.promise);
    });
    lease.release();
    joined = waitForConnectWork();
    void joined.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    await joined;
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  } finally {
    release.resolve();
    lease.release();
    await retained;
    await joined;
  }
});

test.for([
  { field: "verboseLevel", message: "/verbose full", thinking: undefined, scoped: true },
  { field: "thinkingLevel", message: "hello from phone", thinking: "low", scoped: false },
] as const)(
  "chat.send does not persist $field metadata",
  async ({ field, message, thinking, scoped }) => {
    await withMainSessionStore(async () => {
      const run = async (socket: WebSocket) => {
        const idempotencyKey = `idem-chat-${field}-no-persist`;
        const sent = await rpcReq(socket, "chat.send", {
          sessionKey: "main",
          message,
          thinking,
          idempotencyKey,
        });
        expect(sent.ok).toBe(true);
        await waitForAgentRunDrained(idempotencyKey, socket);
        expect(sessionEntry()?.[field]).toBeUndefined();
        if (!scoped) {
          expect(sessionEntry("main")?.[field]).toBeUndefined();
        }
      };
      if (scoped) {
        await withOperator(["operator.write"], run);
      } else {
        await run(ws);
      }
    });
  },
);

test("chat.send preserves sessions and denies operator.write reset triggers", async () => {
  const message = "/reset soft Create a note";
  await useRealReply();
  const replyRun = await import("../auto-reply/reply/get-reply-run.js");
  const runSpy = vi.spyOn(replyRun, "runPreparedReply").mockResolvedValue(undefined);
  // Keep real command/session dispatch; only intercept the model-run boundary.
  try {
    await withMainSessionStore(async () => {
      const sessionStorePath = testState.sessionStorePath;
      if (!sessionStorePath) {
        throw new Error("session store path was not initialized");
      }
      const resetState = {
        lifecycleRevision: "before-reset",
        cliSessionIds: { "claude-cli": "existing-cli-binding" },
      };
      expect(
        await updateSessionEntry(
          { sessionKey: "agent:main:main", storePath: sessionStorePath },
          () => resetState,
        ),
      ).not.toBeNull();
      await withOperator(["operator.read", "operator.write"], async (scopedWs) => {
        const runId = `idem-write-scope-reset-${message}`;
        const { sent: sendRes, settled: final } = await sendUntilTerminal(
          scopedWs,
          runId,
          message,
          ["final"],
        );
        expect(sendRes).toMatchObject({ ok: true, payload: { status: "started" } });

        expect(await waitForRun(scopedWs, runId)).toMatchObject({
          ok: true,
          payload: { status: "ok" },
        });

        expect(sessionEntry()).toMatchObject({ sessionId: "sess-main", ...resetState });
        expect(runSpy).not.toHaveBeenCalled();
        expect(extractFirstTextBlock(final.payload?.message)).toMatch(/not authorized/i);
        expect(extractFirstTextBlock(final.payload?.message)).toContain("operator.admin");
        const stored = await history(scopedWs);
        expect(stored?.sessionId).toBe("sess-main");
        expect(collectHistoryTextValues(stored?.messages ?? [])).toContain(
          extractFirstTextBlock(final.payload?.message),
        );
      });
    });
  } finally {
    runSpy.mockRestore();
  }
});

test("chat.send /reset on an idle session finishes post-commit cleanup and records the turn", async () => {
  await useRealReply();
  // Observe the harness reset that initSessionState runs after the reset commits.
  const harnessReset = vi.spyOn(harnessRegistry, "resetRegisteredAgentHarnessSessions");
  try {
    await withMainSessionStore(async () => {
      const runId = "idem-admin-reset-idle";
      const { settled } = await sendUntilTerminal(ws, runId, "/reset", ["final", "error"]);
      await waitForAgentRunDrained(runId);

      expect(settled.payload?.state).toBe("final");
      expect(extractFirstTextBlock(settled.payload?.message) ?? "").toContain("Session reset");
      expect(harnessReset).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess-main", sessionKey: "agent:main:main" }),
      );
      const stored = await history(ws);
      expect(stored?.messages?.filter((message) => message.role === "user")).toMatchObject([
        { content: "/reset" },
      ]);
    });
  } finally {
    harnessReset.mockRestore();
  }
});

test.for(["agent", "chat"] as const)(
  "agent.wait ignores stale results while same-runId %s is active",
  async (active) => {
    const runId = `idem-wait-active-${active}`;
    await withMainSessionStore(
      async () => {
        const blocked = createDeferred();
        let release = blocked.resolve;
        if (active === "agent") {
          vi.mocked(agentCommandMock).mockImplementationOnce(async () => {
            await blocked.promise;
            return undefined;
          });
        }
        try {
          if (active === "agent") {
            await sendChatAndExpectStarted(runId);
            await waitForAgentRunDrained(runId);
            await startAgent(runId);
          } else {
            await startAgent(runId, "agent:main:stale-wait-snapshot");
            expect(await waitForRun(ws, runId)).toMatchObject({
              ok: true,
              payload: { status: "ok" },
            });
            await gatewaySuite.requestExecution.waitForCompletion(runId);
            release = mockBlockedChatReply();
            await sendChatAndExpectStarted(runId, "hold chat run open");
          }
          expectAgentWaitTimeout(await waitForRun(ws, runId, 40));
          if (active === "agent") {
            release();
            await waitForAgentRunDrained(runId);
          } else {
            await abortChatRun(runId);
          }
        } finally {
          release();
        }
      },
      { freshStore: active === "agent" },
    );
  },
);

test("retains the session fixture while admitted dispatch settles after callback failure", async () => {
  const runId = "idem-fixture-dispatch-throw";
  const dispatchStarted = createDeferred();
  const releaseDispatch = createDeferred();
  const callbackFinished = createDeferred();
  const callbackError = new Error("fixture callback failed");
  let fixtureDir = "";
  let storePath = "";
  dispatchInboundMessageMock.mockImplementationOnce(async () => {
    dispatchStarted.resolve();
    await releaseDispatch.promise;
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  });
  const fixture = withMainSessionStore(
    async (dir) => {
      fixtureDir = dir;
      storePath = path.join(dir, "sessions.json");
      try {
        await sendChatAndExpectStarted(runId, "hold fixture dispatch open");
        await dispatchStarted.promise;
        throw callbackError;
      } finally {
        callbackFinished.resolve();
      }
    },
    { freshStore: true },
  );
  const completion = Promise.allSettled([fixture]);
  try {
    await callbackFinished.promise;
    // Let the fixture's finally run while the admitted dispatch is still held.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);
    expect(testState.sessionStorePath).toBe(storePath);
    expect((await fs.stat(fixtureDir)).isDirectory()).toBe(true);
  } finally {
    releaseDispatch.resolve();
    await completion;
    await settleGatewayFixture();
  }
  expect(await completion).toEqual([{ status: "rejected", reason: callbackError }]);
  expect(testState.sessionStorePath).toBeUndefined();
  await expect(fs.stat(fixtureDir)).rejects.toMatchObject({ code: "ENOENT" });
});
