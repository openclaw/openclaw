import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import * as approvalShared from "./server-methods/approval-shared.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });
type ApprovalRequest = Parameters<typeof approvalShared.handlePendingApprovalRequest>[0];

function lifetimeResources(signal: AbortSignal) {
  let gateway: Awaited<ReturnType<typeof createGatewaySuiteHarness>> | undefined;
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let emergency = false;
  const sockets: WebSocket[] = [];
  const handlers: Promise<void>[] = [];
  const rpcs: Promise<unknown>[] = [];
  const releases: Array<() => Promise<void>> = [];
  const unblocks: Array<() => void> = [];
  const spies = new DisposableStack();
  const outcomes = new Map<string, "fulfilled" | "rejected">();
  const release = async () => {
    const settlements = releases.map((settle) => settle());
    for (const unblock of unblocks) {
      unblock();
    }
    await Promise.all(settlements);
  };
  const onAbort = () => {
    void release();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    unblocks,
    spies,
    rpcs,
    outcomes,
    observeRequest(
      key: (params: ApprovalRequest) => string | undefined,
      transform = (params: ApprovalRequest) => params,
    ) {
      const original = approvalShared.handlePendingApprovalRequest;
      spies.use(
        vi.spyOn(approvalShared, "handlePendingApprovalRequest").mockImplementation((params) => {
          const name = key(params);
          if (name === undefined) {
            return original(params);
          }
          releases.push(async () => {
            const record = params.manager.getLiveSnapshot(params.record.id);
            if (record && record.resolvedAtMs === undefined) {
              await params.manager.resolve(record.id, "deny", "lifetime proof cleanup");
            }
          });
          const run = original(transform(params));
          this.track(name, run);
          return run;
        }),
      );
    },
    track(key: string, work: Promise<void>) {
      handlers.push(
        work.then(
          () => void outcomes.set(key, "fulfilled"),
          () => void outcomes.set(key, "rejected"),
        ),
      );
    },
    async start() {
      gateway = await createGatewaySuiteHarness({
        serverOptions: { bind: "loopback", auth: { mode: "none" } },
      });
      await gateway.server.startupSettled;
    },
    async open(caps: string[] = []) {
      const ws = await expectDefined(gateway, "started gateway").openWs();
      sockets.push(ws);
      await connectOk(ws, { scopes: ["operator.admin"], caps });
      return ws;
    },
    close(reason: string) {
      return (closing ??= expectDefined(gateway, "started gateway").server.close({
        reason,
        drainTimeoutMs: 0,
      }));
    },
    watchdog() {
      timer = setTimeout(() => {
        emergency = true;
        void release();
      }, 5_000);
    },
    get emergency() {
      return emergency;
    },
    async [Symbol.asyncDispose]() {
      clearTimeout(timer);
      await release();
      await Promise.all(handlers);
      for (const ws of sockets) {
        ws.terminate();
      }
      await Promise.allSettled(rpcs);
      await (closing ?? gateway?.server.close({ drainTimeoutMs: 0 }));
      spies.dispose();
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function execRequest(id = randomUUID()) {
  return {
    id,
    command: "printf approval-lifetime",
    requireDeliveryRoute: false,
    suppressDelivery: true,
    twoPhase: true,
    timeoutMs: 600_000,
  };
}

describe("public Gateway close approval lifetime", () => {
  it.for(["exec", "plugin"] as const)(
    "retires %s request and decision observers without recording a decision",
    async (kind, { signal }) => {
      await using fixture = lifetimeResources(signal);
      const waitEntered = createDeferredCore();
      let approvalId: string | undefined;
      const originalWait = approvalShared.handleApprovalWaitDecision;
      fixture.observeRequest((params) => {
        if (params.approvalKind !== kind) {
          return undefined;
        }
        approvalId = params.record.id;
        return "request";
      });
      fixture.spies.use(
        vi.spyOn(approvalShared, "handleApprovalWaitDecision").mockImplementation((params) => {
          const run = originalWait(params);
          if (params.inputId === approvalId) {
            fixture.track("wait", run);
            waitEntered.resolve();
          }
          return run;
        }),
      );
      await fixture.start();
      const requester = await fixture.open();
      const observer = await fixture.open([GATEWAY_CLIENT_CAPS.APPROVALS]);
      const params =
        kind === "exec"
          ? execRequest()
          : {
              pluginId: "example",
              title: "Approval lifetime proof",
              description: "Synthetic operation; no action is executed.",
              twoPhase: true,
              timeoutMs: 600_000,
            };
      const accepted = await rpcReq<{ id: string; status: string }>(
        requester,
        `${kind}.approval.request`,
        params,
      );
      expect(accepted).toMatchObject({ ok: true, payload: { status: "accepted" } });
      const id = expectDefined(accepted.payload, "accepted approval").id;
      expect(approvalId).toBe(id);
      const beforeClose = await getOperatorApprovalDetailed({ id });
      expect(beforeClose).toMatchObject({ outcome: "found", record: { status: "pending" } });

      const disconnected = once(requester, "close");
      requester.close();
      await disconnected;
      await nextTurn();
      expect(fixture.outcomes.get("request")).toBeUndefined();

      const observerRpc = rpcReq(observer, `${kind}.approval.waitDecision`, { id });
      fixture.rpcs.push(observerRpc);
      void observerRpc.catch(() => {});
      await Promise.race([
        waitEntered.promise,
        observerRpc.then(() => {
          throw new Error("approval wait returned before observing the pending decision");
        }),
      ]);
      expect(fixture.outcomes.get("wait")).toBeUndefined();
      // The broken join is released with a real denial, never an abandoned handler.
      fixture.watchdog();
      await fixture.close("approval lifetime proof");
      expect(fixture.emergency).toBe(false);
      expect(Object.fromEntries(fixture.outcomes)).toMatchObject({
        request: "rejected",
        wait: "rejected",
      });
      // Closing request observers must leave the persisted pending approval unchanged.
      expect(await getOperatorApprovalDetailed({ id })).toEqual(beforeClose);
    },
  );

  it.for(["allow-once", "expired"] as const)(
    "keeps a recorded %s handoff when close races its promise continuation",
    async (terminal, { signal }) => {
      await using fixture = lifetimeResources(signal);
      const pendingId = randomUUID();
      const committedId = randomUUID();
      const handoffEntered = createDeferredCore();
      const releaseHandoff = createDeferredCore();
      const decisions: unknown[] = [];
      const observations: {
        commit?: () => Promise<boolean>;
        bindingRetained?: boolean;
        consumed?: boolean;
        handoffFinished: boolean;
        closed: boolean;
      } = { handoffFinished: false, closed: false };
      fixture.observeRequest(
        ({ record: { id } }) => (id === pendingId || id === committedId ? id : undefined),
        (params) => {
          const id = params.record.id;
          if (id === committedId) {
            observations.commit = async () =>
              terminal === "allow-once"
                ? await params.manager.resolve(id, "allow-once", "lifetime proof reviewer")
                : await params.manager.expire(id);
          }
          const afterDecision = params.afterDecision;
          return {
            ...params,
            afterDecision: async (decision, event) => {
              await afterDecision?.(decision, event);
              if (id !== committedId) {
                return;
              }
              decisions.push(decision);
              handoffEntered.resolve();
              await releaseHandoff.promise;
              observations.bindingRetained = params.manager.getLiveSnapshot(id) !== null;
              if (decision === "allow-once") {
                observations.consumed = await params.manager.consumeAllowOnce(
                  id,
                  "lifetime proof handoff",
                );
              }
              observations.handoffFinished = true;
            },
          };
        },
      );
      fixture.unblocks.push(() => releaseHandoff.resolve());
      await fixture.start();
      const ws = await fixture.open();
      for (const id of [pendingId, committedId]) {
        const accepted = await rpcReq(ws, "exec.approval.request", execRequest(id));
        expect(accepted).toMatchObject({ ok: true, payload: { status: "accepted" } });
      }
      fixture.watchdog();
      // Commit durably, then close while the retained decision handoff is still running.
      expect(await expectDefined(observations.commit, "recorded approval transition")()).toBe(true);
      const closing = fixture.close("committed approval handoff proof").then(() => {
        observations.closed = true;
      });
      await handoffEntered.promise;
      await nextTurn();
      expect(decisions).toEqual([terminal === "allow-once" ? "allow-once" : null]);
      expect(fixture.outcomes.get(pendingId)).toBe("rejected");
      expect(observations).toMatchObject({ handoffFinished: false, closed: false });
      releaseHandoff.resolve();
      await closing;
      expect(fixture.emergency).toBe(false);
      expect(fixture.outcomes.get(committedId)).toBe("fulfilled");
      expect(observations).toMatchObject({ bindingRetained: true, handoffFinished: true });
      if (terminal === "allow-once") {
        expect(observations.consumed).toBe(true);
      }
      expect(await getOperatorApprovalDetailed({ id: pendingId })).toMatchObject({
        outcome: "found",
        record: { status: "pending", decision: null, terminalReason: null },
      });
      expect(await getOperatorApprovalDetailed({ id: committedId })).toMatchObject({
        outcome: "found",
        record: {
          status: terminal === "allow-once" ? "allowed" : "expired",
          decision: terminal === "allow-once" ? "allow-once" : "deny",
          terminalReason: terminal === "allow-once" ? "user" : "timeout",
        },
      });
    },
  );
});
