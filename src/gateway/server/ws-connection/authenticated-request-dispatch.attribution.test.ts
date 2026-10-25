import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { serializeGatewayFrame } from "../../serialized-json.js";
import type { GatewayRequestHandler } from "../../server-methods/types.js";
import { captureSessionRowGeneration } from "../../session-row-identity.js";
import { shareSidebarSessionRows } from "../../session-row-presentation.js";
import { dispatchProfile } from "../client-fixtures.test-support.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
  requestFrame,
} from "./authenticated-request-dispatch.test-support.js";

beforeEach(() => resetDiagnosticEventsForTest());
afterEach(() => resetDiagnosticEventsForTest());

const revision = "private-revision";
const unchanged = { rowsUnchanged: true };
const delta = { rowsDelta: { baseRevision: revision } };
const full = { sessions: [] };
function expectWireResponse(
  events: unknown[],
  field: "sessionsList" | "chatHistory",
  details: Record<string, unknown>,
  copies = 1,
) {
  const attribution = { clientKind: "openclaw-control-ui", source: "wire", ...details };
  const expected = { responseBytes: 1234, [field]: attribution };
  expect(events).toMatchObject(Array.from({ length: copies }, () => expected));
  expect(JSON.stringify(events)).not.toContain("private-");
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  payload: unknown,
  delivery: "wire" | "shared" | "internal" | "error" | "unavailable" | "serialization" = "wire",
) {
  const events: DiagnosticEventPayload[] = [];
  onTestFinished(
    onInternalDiagnosticEvent((event) => events.push(event), { include: ["gateway.rpc"] }),
  );
  const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
    respond(delivery !== "error", payload),
  );
  const harness = createDispatchTestHarness({ extraHandlers: { [method]: handler } });
  const { dispatch: dispatchRequest } = harness.dispatcher;
  harness.send.mockReturnValue(
    delivery === "unavailable" ? { kind: "unavailable" } : { kind: "sent", bytes: 1234 },
  );
  if (delivery === "serialization") {
    harness.send.mockReturnValueOnce({ kind: "serialization", error: new Error("synthetic") });
  }
  const client = createOperatorWsClient({
    clientInfo: { id: "openclaw-control-ui", mode: "webchat" },
  });
  if (delivery === "shared") {
    client.authenticatedUserProfile = dispatchProfile("private-profile", {
      displayName: "Test operator",
      avatarRevision: "0",
      updatedAt: 0,
    });
  }
  const request = requestFrame("private-request", method, params);
  const internalSend = delivery === "internal" ? harness.send : undefined;
  await dispatchRequest(request, client, undefined, internalSend);
  if (delivery === "shared") {
    await harness.dispatcher.dispatch({ ...request, id: "private-follower" }, client);
    expect(handler).toHaveBeenCalledOnce();
    for (const [frame] of harness.send.mock.calls) {
      expect(JSON.parse(serializeGatewayFrame(frame).toString()).payload).toEqual(payload);
    }
  }
  await waitForDiagnosticEventsDrained();
  return events.filter((event) => event.type === "gateway.rpc" && event.phase === "response");
}

it.each(["wire", "shared", "internal"] as const)(
  "attributes base misses out-of-band through %s responses",
  async (delivery) => {
    const row = { key: "one", kind: "direct", updatedAt: 1 } as const;
    const previous = [row];
    const base = shareSidebarSessionRows(previous);
    const changed = [{ ...row, updatedAt: 2 }];
    for (const [token, reason] of [
      [`delta:${base.rowsRevision}`, "all-rows-changed"],
      ["delta:unknown", "unknown-base"],
    ] as const) {
      const payload = shareSidebarSessionRows(changed, token, [
        captureSessionRowGeneration(previous),
      ]);
      expect(Object.keys(payload).toSorted()).toEqual(["rowsRevision", "sessions", "sharedFacts"]);
      const events = await dispatch(
        "sessions.list",
        { rowMode: "sidebar", ifRowsRevision: token },
        payload,
        delivery,
      );
      const expected = { rowsOutcome: "full-with-base", baseMissReason: reason };
      expect(events.map((event) => event.sessionsList)).toMatchObject(
        delivery === "shared" ? [expected, expected] : [expected],
      );
    }
    const noBase = shareSidebarSessionRows(changed);
    const events = await dispatch("sessions.list", { rowMode: "sidebar" }, noBase, delivery);
    expect(events[0]?.sessionsList).not.toHaveProperty("baseMissReason");
  },
);

it.each([
  ["sidebar", revision, unchanged, "unchanged"],
  ["sidebar", `delta:${revision}`, delta, "delta"],
  ["sidebar", undefined, full, "full-no-base"],
  ["sidebar", `delta:${revision}`, full, "full-with-base"],
  ["sidebar", revision, full, "full-with-base"],
  ["compact", undefined, full, "not-sidebar"],
  ["compact", "", full, "full-no-base"],
  ["compact", revision, unchanged, "unchanged"],
  ["compact", `delta:${revision}`, delta, "delta"],
] as const)(
  "attributes session response bytes (%s, %s, %j, %s)",
  async (rowMode, ifRowsRevision, payload, rowsOutcome) => {
    for (const delivery of ["wire", "shared"] as const) {
      const events = await dispatch(
        "sessions.list",
        { rowMode, ...(ifRowsRevision !== undefined ? { ifRowsRevision } : {}), source: "sidebar" },
        payload,
        delivery,
      );
      expectWireResponse(
        events,
        "sessionsList",
        { callerSource: "sidebar", rowMode, filter: "general", rowsOutcome },
        delivery === "shared" ? 2 : 1,
      );
    }
  },
);

const receiptQuery = { inputRunIds: ["private-"], cursor: "private-", pendingBefore: 2, limit: 81 };
it.each([
  [{ cursor: "private-c", limit: 20 }, "delta", "cursor", "<=20"],
  [{ offset: 1, limit: 21 }, undefined, "older", "<=80"],
  [{ pendingBefore: 2, offset: 1, limit: 80 }, undefined, "pending", "<=80"],
  [receiptQuery, "reset", "receipt", "<=200"],
  [{ offset: 0 }, undefined, "tail", "<=200"],
  [{ messageId: "private-m", sessionId: "private-s" }, undefined, "anchor", "<=200"],
  [{ limit: 201 }, undefined, "tail", ">200"],
] as const)(
  "attributes validated history response shape (%j, %s, %s, %s)",
  async (params, kind, shape, limitBucket) => {
    const events = await dispatch(
      "chat.history",
      { sessionKey: "private-session", ...params },
      { kind },
    );
    expectWireResponse(events, "chatHistory", { shape, limitBucket, outcome: kind ?? "page" });
  },
);

it("preserves internal history source and excludes failed responses and startup", async () => {
  const params = { sessionKey: "private-session", cursor: "private-cursor" };
  expect(await dispatch("chat.history", params, { kind: "delta" }, "internal")).toMatchObject([
    { responseBytes: 1234, chatHistory: { source: "internal", shape: "cursor", outcome: "delta" } },
  ]);
  for (const method of ["sessions.list", "chat.history", "chat.startup"]) {
    for (const delivery of ["error", "unavailable", "serialization"] as const) {
      const events = await dispatch(method, params, { kind: "delta" }, delivery);
      expect(events).toHaveLength(1);
      expect(events[0]).not.toHaveProperty("chatHistory");
      expect(events[0]).not.toHaveProperty("sessionsList");
    }
  }
  expect(await dispatch("chat.startup", params, { kind: "delta" })).toEqual([
    expect.not.objectContaining({ chatHistory: expect.anything() }),
  ]);
});
