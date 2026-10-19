// Gateway server chat tests cover WebSocket chat flow, history construction,
// NO_REPLY handling, agent events, and connected control-UI delivery.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import * as harnessRegistry from "../agents/harness/registry.js";
import { loadSessionEntry, updateSessionEntry } from "../config/sessions/session-accessor.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { installGatewayServerChatTestSuite } from "./server.chat.gateway-server-chat.test-support.js";
import { collectHistoryTextValues } from "./session-history-fixtures.test-support.js";
import { removeChatTestDirectory as removeTempDir } from "./session-test-directories.test-support.js";
import {
  connectOk,
  dispatchInboundMessageMock,
  mockGetReplyFromConfigOnce,
  onceMessage,
  rpcReq,
  testState,
  trackConnectChallengeNonce,
  writeSessionStore,
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

describe("gateway server chat", () => {
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

  test("chat.send does not persist verboseLevel for operator.write callers", async () => {
    await withMainSessionStore(async () => {
      let scopedWs: WebSocket | undefined;

      try {
        scopedWs = new WebSocket(`ws://127.0.0.1:${port}`);
        trackConnectChallengeNonce(scopedWs);
        await new Promise<void>((resolve) => {
          scopedWs?.once("open", resolve);
        });
        await connectOk(scopedWs, {
          scopes: ["operator.write"],
        });

        const sendRes = await rpcReq(scopedWs, "chat.send", {
          sessionKey: "main",
          message: "/verbose full",
          idempotencyKey: "idem-write-scope-verbose-no-persist",
        });
        expect(sendRes.ok).toBe(true);

        await waitForAgentRunDrained("idem-write-scope-verbose-no-persist", scopedWs);

        const sessionStorePath = testState.sessionStorePath;
        if (!sessionStorePath) {
          throw new Error("session store path was not initialized");
        }
        expect(
          loadSessionEntry({ sessionKey: "agent:main:main", storePath: sessionStorePath })
            ?.verboseLevel,
        ).toBeUndefined();
      } finally {
        scopedWs?.close();
      }
    });
  });

  test("chat.send does not persist one-turn thinking metadata", async () => {
    await withMainSessionStore(async () => {
      const sendRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello from phone",
        thinking: "low",
        idempotencyKey: "idem-chat-thinking-no-persist",
      });
      expect(sendRes.ok).toBe(true);

      await waitForAgentRunDrained("idem-chat-thinking-no-persist");

      const sessionStorePath = testState.sessionStorePath;
      if (!sessionStorePath) {
        throw new Error("session store path was not initialized");
      }
      expect(
        loadSessionEntry({ sessionKey: "agent:main:main", storePath: sessionStorePath })
          ?.thinkingLevel,
      ).toBeUndefined();
      expect(
        loadSessionEntry({ sessionKey: "main", storePath: sessionStorePath })?.thinkingLevel,
      ).toBeUndefined();
    });
  });

  test("chat.send preserves sessions and denies operator.write reset triggers", async () => {
    const message = "/reset soft Create a note";
    const { getReplyFromConfig } = await import("../auto-reply/reply/get-reply.js");
    const { withFullRuntimeReplyConfig } =
      await import("../auto-reply/reply/get-reply-fast-path.js");
    const replyRun = await import("../auto-reply/reply/get-reply-run.js");
    const runSpy = vi.spyOn(replyRun, "runPreparedReply").mockResolvedValue(undefined);
    // Keep real command/session dispatch; only intercept the model-run boundary.
    mockGetReplyFromConfigOnce((ctx, opts, cfg) =>
      getReplyFromConfig(ctx, opts, cfg ? withFullRuntimeReplyConfig(cfg) : cfg),
    );
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
        let scopedWs: WebSocket | undefined;

        try {
          scopedWs = new WebSocket(`ws://127.0.0.1:${port}`);
          trackConnectChallengeNonce(scopedWs);
          await new Promise<void>((resolve) => {
            scopedWs?.once("open", resolve);
          });
          await connectOk(scopedWs, {
            scopes: ["operator.read", "operator.write"],
          });

          const runId = `idem-write-scope-reset-${message}`;
          const finalPromise = onceMessage(
            scopedWs,
            (event) =>
              event.type === "event" &&
              event.event === "chat" &&
              event.payload?.state === "final" &&
              event.payload?.runId === runId,
          );
          // Observe both promises immediately so an RPC failure cannot strand the final listener.
          const [sendRes, final] = await Promise.all([
            rpcReq(scopedWs, "chat.send", {
              sessionKey: "main",
              message,
              idempotencyKey: runId,
            }),
            finalPromise,
          ]);
          expect(sendRes.ok).toBe(true);
          expect(sendRes.payload?.status).toBe("started");

          const waitRes = await rpcReq(scopedWs, "agent.wait", {
            runId,
            timeoutMs: 1_000,
          });
          expect(waitRes.ok).toBe(true);
          expect(waitRes.payload?.status).toBe("ok");

          expect(
            loadSessionEntry({ sessionKey: "agent:main:main", storePath: sessionStorePath }),
          ).toMatchObject({ sessionId: "sess-main", ...resetState });
          expect(runSpy).not.toHaveBeenCalled();
          expect(extractFirstTextBlock(final.payload?.message)).toMatch(/not authorized/i);
          expect(extractFirstTextBlock(final.payload?.message)).toContain("operator.admin");
          const history = await rpcReq<{ sessionId?: string; messages?: unknown[] }>(
            scopedWs,
            "chat.history",
            {
              sessionKey: "main",
            },
          );
          expect(history.ok).toBe(true);
          expect(history.payload?.sessionId).toBe("sess-main");
          expect(collectHistoryTextValues(history.payload?.messages ?? [])).toContain(
            extractFirstTextBlock(final.payload?.message),
          );
        } finally {
          scopedWs?.close();
        }
      });
    } finally {
      runSpy.mockRestore();
    }
  });

  test("chat.send /reset on an idle session finishes post-commit cleanup and records the turn", async () => {
    const { getReplyFromConfig } = await import("../auto-reply/reply/get-reply.js");
    const { withFullRuntimeReplyConfig } =
      await import("../auto-reply/reply/get-reply-fast-path.js");
    // Observe the harness reset that initSessionState runs after the reset commits.
    const harnessReset = vi.spyOn(harnessRegistry, "resetRegisteredAgentHarnessSessions");
    mockGetReplyFromConfigOnce((ctx, opts, cfg) =>
      getReplyFromConfig(ctx, opts, cfg ? withFullRuntimeReplyConfig(cfg) : cfg),
    );
    try {
      await withMainSessionStore(async () => {
        const runId = "idem-admin-reset-idle";
        const terminal = onceMessage(
          ws,
          (event) =>
            event.type === "event" &&
            event.event === "chat" &&
            event.payload?.runId === runId &&
            (event.payload?.state === "final" || event.payload?.state === "error"),
        );
        const [sendRes, settled] = await Promise.all([
          rpcReq(ws, "chat.send", { sessionKey: "main", message: "/reset", idempotencyKey: runId }),
          terminal,
        ]);
        expect(sendRes.ok).toBe(true);
        await waitForAgentRunDrained(runId);

        expect(settled.payload?.state).toBe("final");
        expect(extractFirstTextBlock(settled.payload?.message) ?? "").toContain("Session reset");
        expect(harnessReset).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: "sess-main", sessionKey: "agent:main:main" }),
        );
        const history = await rpcReq<{ messages?: Array<{ role?: string; content?: unknown }> }>(
          ws,
          "chat.history",
          { sessionKey: "main" },
        );
        expect(history.ok).toBe(true);
        expect(
          history.payload?.messages?.filter((message) => message.role === "user"),
        ).toMatchObject([{ content: "/reset" }]);
      });
    } finally {
      harnessReset.mockRestore();
    }
  });

  test("agent.wait ignores stale chat dedupe when an agent run with the same runId is in flight", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    const { promise: blockedAgentRun, resolve: resolveAgentRun } = createDeferred();
    const agentSpy = vi.mocked(agentCommandMock);
    agentSpy.mockImplementationOnce(async () => {
      await blockedAgentRun;
      return undefined;
    });

    const runId = "idem-wait-chat-vs-agent";
    try {
      testState.sessionStorePath = path.join(dir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      await sendChatAndExpectStarted(runId);
      await waitForAgentRunDrained(runId);

      const agentRes = await rpcReq(ws, "agent", {
        sessionKey: "main",
        message: "hold this run open",
        idempotencyKey: runId,
      });
      expect(agentRes.ok).toBe(true);
      expect(agentRes.payload?.status).toBe("accepted");

      const waitWhileAgentInFlight = await rpcReq(ws, "agent.wait", {
        runId,
        timeoutMs: 40,
      });
      expectAgentWaitTimeout(waitWhileAgentInFlight);

      resolveAgentRun?.();
      await waitForAgentRunDrained(runId);
    } finally {
      resolveAgentRun?.();
      await settleGatewayFixture();
      await removeTempDir(dir);
    }
  });

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

  test("agent.wait ignores stale agent snapshots while same-runId chat.send is active", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-wait-chat-active-vs-stale-agent";
      const seedAgentRes = await rpcReq(ws, "agent", {
        sessionKey: "agent:main:stale-wait-snapshot",
        message: "seed stale agent snapshot",
        idempotencyKey: runId,
      });
      expect(seedAgentRes.ok).toBe(true);
      expect(seedAgentRes.payload?.status).toBe("accepted");

      const seedWaitRes = await rpcReq(ws, "agent.wait", {
        runId,
        timeoutMs: 1_000,
      });
      expect(seedWaitRes.ok).toBe(true);
      expect(seedWaitRes.payload?.status).toBe("ok");
      await gatewaySuite.requestExecution.waitForCompletion(runId);

      const releaseBlockedReply = mockBlockedChatReply();

      try {
        await sendChatAndExpectStarted(runId, "hold chat run open");

        const waitWhileChatActive = await rpcReq(ws, "agent.wait", {
          runId,
          timeoutMs: 40,
        });
        expectAgentWaitTimeout(waitWhileChatActive);

        await abortChatRun(runId);
      } finally {
        releaseBlockedReply();
      }
    });
  });
});
