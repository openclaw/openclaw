import { describe, expect, it, vi } from "vitest";
import { createWorkerInferenceCancellationService } from "../worker-environments/inference-control.test-helpers.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import * as persistence from "./chat-transcript-persistence.js";
import {
  expectAbortPayload,
  invokeAbort,
  requireLastRespondCall,
} from "./chat.abort-authorization.test-helpers.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

vi.mock("../session-utils.js", async () => {
  return {
    ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
    loadSessionEntry: () => ({ entry: { sessionId: "main-session" } }),
  };
});

describe("chat.abort original authority and registration", () => {
  it.each(["queued", "active", "lifecycle"] as const)(
    "stops subsequent effects after a synchronous %s cancellation revokes authority",
    async (firstEffect) => {
      let current = true;
      const cancelInferenceForSession = vi.fn(() => ["worker"]);
      const context = createChatAbortContext({
        workerEnvironmentService: createWorkerInferenceCancellationService(
          "main-session",
          ["worker"],
          cancelInferenceForSession,
        ),
      });
      const first = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
      const second = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
      if (firstEffect === "queued") {
        context.chatQueuedTurns.set("first", first);
        context.chatQueuedTurns.set("second", second);
      } else {
        context.chatAbortControllers.set("first", first);
        context.chatAbortControllers.set("second", second);
        context.chatRunState.getOrCreate("first").buffer = "committed partial";
        context.chatRunState.getOrCreate("second").buffer = "untouched partial";
      }
      if (firstEffect !== "lifecycle") {
        first.controller.signal.addEventListener(
          "abort",
          () => {
            current = false;
          },
          { once: true },
        );
      }
      const lifecycle = vi.fn(() => {
        if (firstEffect === "lifecycle") {
          current = false;
        }
        return true;
      });
      for (const prefix of ["agent", "pending-chat"]) {
        context.dedupe.set(`${prefix}:pending`, {
          ts: 1,
          ok: true,
          payload: {
            runId: "pending",
            status: "accepted",
            sessionKey: "main",
            agentId: "main",
          },
        });
      }
      const pending = [...context.dedupe];
      const persist = vi.spyOn(persistence, "persistAbortedPartials").mockResolvedValue(undefined);
      try {
        await expect(
          invokeChatAbortHandler({
            handler: (options) =>
              handleChatAbortRequestWithLifecycle(
                {
                  ...options,
                  hasCurrentClientAuthority: () => current,
                },
                { onAuthorizedAfterQueuedAbort: lifecycle },
              ),
            context,
            request: { sessionKey: "main" },
            client: { connect: { scopes: ["operator.admin"] } },
          }),
        ).rejects.toThrow("requester authority changed");
        expect(first.controller.signal.aborted).toBe(firstEffect !== "lifecycle");
        expect(second.controller.signal.aborted).toBe(false);
        expect([...context.dedupe]).toEqual(pending);
        expect(cancelInferenceForSession).not.toHaveBeenCalled();
        expect(lifecycle).toHaveBeenCalledTimes(firstEffect === "queued" ? 0 : 1);
        if (firstEffect === "active") {
          expect(persist).toHaveBeenCalledOnce();
          expect(persist.mock.calls[0]?.[0].snapshots.map((snapshot) => snapshot.runId)).toEqual([
            "first",
          ]);
          expect(context.chatRunState.resolveBuffer("second", { final: true }).text).toBe(
            "untouched partial",
          );
        } else {
          expect(persist.mock.calls.flatMap(([call]) => call.snapshots)).toEqual([]);
          if (firstEffect === "queued") {
            expect(persist).not.toHaveBeenCalled();
          } else {
            expect(context.chatRunState.resolveBuffer("first", { final: true }).text).toBe(
              "committed partial",
            );
            expect(context.chatRunState.resolveBuffer("second", { final: true }).text).toBe(
              "untouched partial",
            );
          }
        }
      } finally {
        persist.mockRestore();
      }
    },
  );

  it("does not adopt replacement active and pending registrations during a session-wide Stop", async () => {
    const context = createChatAbortContext();
    const first = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
    const stale = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
    const replacement = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
    context.chatAbortControllers.set("first", first);
    context.chatAbortControllers.set("reused", stale);
    for (const prefix of ["agent", "pending-chat"]) {
      context.dedupe.set(`${prefix}:pending`, {
        ts: 1,
        ok: true,
        payload: {
          runId: "pending",
          status: "accepted",
          sessionKey: "main",
          agentId: "main",
          reservationId: "old",
          attemptId: "old",
        },
      });
    }
    let pending: Array<[string, unknown]> = [];
    first.controller.signal.addEventListener(
      "abort",
      () => {
        context.chatAbortControllers.set("reused", replacement);
        for (const prefix of ["agent", "pending-chat"]) {
          context.dedupe.set(`${prefix}:pending`, {
            ts: 2,
            ok: true,
            payload: {
              runId: "pending",
              status: "accepted",
              sessionKey: "main",
              agentId: "main",
              reservationId: "new",
              attemptId: "new",
            },
          });
        }
        pending = [...context.dedupe];
      },
      { once: true },
    );
    const response = await invokeAbort({
      context,
      sessionKey: "main",
      connId: "owner",
      deviceId: "device",
      scopes: ["operator.admin"],
    });
    expectAbortPayload(requireLastRespondCall(response)[1], { aborted: true, runIds: ["first"] });
    expect(stale.controller.signal.aborted).toBe(false);
    expect(replacement.controller.signal.aborted).toBe(false);
    expect([...context.dedupe]).toEqual(pending);
  });

  it.each(["active", "queued", "pending-chat", "agent", "worker"] as const)(
    "retains the original source and target fence before explicit %s cancellation",
    async (kind) => {
      for (const changed of ["source", "target"] as const) {
        const cancelInferenceForSession = vi.fn(() => ["run-1"]);
        const run = createActiveRun("agent:main:main", { agentId: "main" });
        const context = createChatAbortContext({
          workerEnvironmentService: createWorkerInferenceCancellationService(
            "main-session",
            kind === "worker" ? ["run-1"] : [],
            cancelInferenceForSession,
          ),
        });
        if (kind === "active") {
          context.chatAbortControllers.set("run-1", run);
        } else if (kind === "queued") {
          context.chatQueuedTurns.set("run-1", run);
        } else if (kind !== "worker") {
          context.dedupe.set(`${kind}:run-1`, {
            ts: Date.now(),
            ok: true,
            payload: {
              runId: "run-1",
              sessionKey: "agent:main:main",
              agentId: "main",
              status: "accepted",
            },
          });
        }
        const before = [...context.dedupe];
        await expect(
          invokeChatAbortHandler({
            handler: (options) =>
              handleChatAbortRequestWithLifecycle({
                ...options,
                hasCurrentClientAuthority: () => changed !== "source",
                sessionMutationAuthorization: {
                  assertCurrent: () => {
                    throw new Error("target changed");
                  },
                  assertTargetCurrent: () => {
                    throw new Error("target changed");
                  },
                },
              }),
            context,
            request: { sessionKey: "agent:main:main", runId: "run-1" },
            client: { connId: "owner", connect: { scopes: ["operator.admin"] } },
          }),
        ).rejects.toThrow(changed === "source" ? "requester authority changed" : "target changed");
        expect(run.controller.signal.aborted).toBe(false);
        expect(context.chatAbortControllers.has("run-1")).toBe(kind === "active");
        expect(context.chatQueuedTurns.has("run-1")).toBe(kind === "queued");
        expect([...context.dedupe]).toEqual(before);
        expect(cancelInferenceForSession).not.toHaveBeenCalled();
      }
    },
  );

  it("does not fall back to live worker queries without a registered capture owner", async () => {
    const cancelInferenceForSession = vi.fn(() => ["worker-run"]);
    const context = createChatAbortContext({
      workerEnvironmentService: {
        cancelInferenceForSession,
        hasInferenceForSession: () => true,
      },
    });
    for (const runId of [undefined, "worker-run"]) {
      const response = await invokeAbort({
        context,
        runId,
        connId: "admin",
        deviceId: "admin",
        scopes: ["operator.admin"],
      });
      expectAbortPayload(requireLastRespondCall(response)[1], { aborted: false, runIds: [] });
    }
    expect(cancelInferenceForSession).not.toHaveBeenCalled();
  });
});
