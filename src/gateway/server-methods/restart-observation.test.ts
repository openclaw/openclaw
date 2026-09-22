import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  createChildDiagnosticTraceContext,
  formatDiagnosticTraceparent,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import { restartHandlers } from "./restart.js";

const signalAdmission = vi.hoisted(() =>
  vi.fn<() => { status: "emitted" | "coalesced" | "failed" }>(() => ({ status: "emitted" })),
);
const activeLock = vi.hoisted(() => vi.fn());
vi.mock("../../infra/restart.js", () => ({
  requestGatewayRestartWithSignalAdmission: signalAdmission,
}));
vi.mock("../../infra/gateway-lock.js", () => ({ readActiveGatewayLockIdentity: activeLock }));
type Admission = Extract<DiagnosticEventPayload, { type: "gateway.admission" }>;
let observed: Array<{ event: Admission; metadata: DiagnosticEventMetadata }> = [];
beforeEach(() => {
  resetGatewayWorkAdmission();
  resetDiagnosticEventsForTest();
  observed = [];
  signalAdmission.mockReset().mockReturnValue({ status: "emitted" });
  activeLock
    .mockReset()
    .mockResolvedValue({ pid: process.pid, ownerId: "private-owner-canary", port: 18789 });
  onInternalDiagnosticEvent(
    (event, metadata) => {
      if (event.type === "gateway.admission") {
        observed.push({ event, metadata });
      }
    },
    { include: ["gateway.admission"] },
  );
});
afterEach(async () => {
  await waitForDiagnosticEventsDrained();
  resetDiagnosticEventsForTest();
  resetGatewayWorkAdmission();
});
async function invoke(
  traceparent: string | undefined,
  options: { scopes?: string[]; validTarget?: boolean } = {},
) {
  const harness = createDispatchTestHarness({
    extraHandlers: restartHandlers,
    buildRequestContext: () => ({
      logGateway: { warn: vi.fn(), error: vi.fn() },
      getRuntimeConfig: () => ({}),
    }),
  });
  const client = createOperatorWsClient({ socket: new EventEmitter(), scopes: options.scopes });
  await harness.dispatcher.dispatch(
    {
      type: "req",
      id: "private-rpc-canary",
      method: "gateway.restart.request",
      params: {
        safe: false,
        target: {
          pid: process.pid,
          ownerId: options.validTarget === false ? "wrong" : "private-owner-canary",
          port: 18789,
        },
        restartIntent: {},
      },
      ...(traceparent !== undefined ? { traceparent } : {}),
    },
    client,
  );
  await waitForDiagnosticEventsDrained();
  return harness.send.mock.calls[0]?.[0];
}
describe("native restart admission trace observation", () => {
  it.each(["emitted", "coalesced", "failed"] as const)(
    "records actual %s using the authenticated receiver span, without a model caller frame",
    async (status) => {
      signalAdmission.mockReturnValue({ status });
      const T = createDiagnosticTraceContext(),
        R = createChildDiagnosticTraceContext(T);
      const response = await invoke(formatDiagnosticTraceparent(R));
      expect(response).toMatchObject({ ok: status !== "failed" });
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        event: {
          type: "gateway.admission",
          method: "gateway.restart.request",
          outcome: status,
          trace: { traceId: R.traceId, parentSpanId: R.spanId },
        },
        metadata: { trusted: true, internal: true, coreGatewayAdmission: true },
      });
      expect(observed[0]?.event.trace?.spanId).not.toBe(R.spanId);
      expect(observed[0]?.event).not.toHaveProperty("gatewayOwner");
      expect(JSON.stringify(observed)).not.toContain("private-owner-canary");
      expect(JSON.stringify(observed)).not.toContain("private-rpc-canary");
    },
  );
  it.each([undefined, "bad-trace", "00-" + "0".repeat(32) + "-" + "1".repeat(16) + "-01"])(
    "does not fabricate association for absent/malformed carrier %s",
    async (carrier) => {
      const ambient = createChildDiagnosticTraceContext(createDiagnosticTraceContext());
      await runWithDiagnosticTraceContext(ambient, () => invoke(carrier));
      expect(signalAdmission).toHaveBeenCalledOnce();
      expect(observed).toEqual([]);
    },
  );
  it("does not equate another valid request trace with the intended request", async () => {
    const intended = createDiagnosticTraceContext(),
      other = createDiagnosticTraceContext();
    await invoke(formatDiagnosticTraceparent(other));
    expect(observed).toHaveLength(1);
    expect(observed[0]?.event.trace?.traceId).not.toBe(intended.traceId);
    expect(observed[0]?.event.trace?.parentSpanId).not.toBe(intended.spanId);
  });
  it("records both actual calls on replay; correlation never deduplicates or authorizes RPCs", async () => {
    const R = createDiagnosticTraceContext();
    await invoke(formatDiagnosticTraceparent(R));
    await invoke(formatDiagnosticTraceparent(R));
    expect(signalAdmission).toHaveBeenCalledTimes(2);
    expect(observed).toHaveLength(2);
    expect(observed.every((x) => x.event.trace?.parentSpanId === R.spanId)).toBe(true);
    expect(observed[0]?.event.trace?.spanId).not.toBe(observed[1]?.event.trace?.spanId);
  });
  it.each([{ scopes: ["operator.read"] }, { validTarget: false }])(
    "does not claim admission after actual rejection %j",
    async (options) => {
      const response = await invoke(
        formatDiagnosticTraceparent(createDiagnosticTraceContext()),
        options,
      );
      expect(response).toMatchObject({ ok: false });
      expect(signalAdmission).not.toHaveBeenCalled();
      expect(observed).toEqual([]);
    },
  );
  it("keeps native provenance nonreplayable and excludes public listeners", async () => {
    const publicListener = vi.fn();
    onDiagnosticEvent(publicListener);
    await invoke(formatDiagnosticTraceparent(createDiagnosticTraceContext()));
    expect(publicListener).not.toHaveBeenCalled();
    const event = observed[0]?.event;
    if (!event) {
      throw new Error("missing native fixture observation");
    }
    const fake = { ...event, coreGatewayAdmission: true };
    emitTrustedDiagnosticEvent(fake);
    await waitForDiagnosticEventsDrained();
    expect(observed.at(-1)?.metadata.coreGatewayAdmission).toBeUndefined();
  });
  it("leaves action semantics unchanged while disabled, with no admission observation", async () => {
    setDiagnosticsEnabledForProcess(false);
    const response = await invoke(formatDiagnosticTraceparent(createDiagnosticTraceContext()));
    expect(response).toMatchObject({ ok: true });
    expect(signalAdmission).toHaveBeenCalledOnce();
    expect(observed).toEqual([]);
  });
});
