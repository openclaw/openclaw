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
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

beforeEach(() => resetDiagnosticEventsForTest());
afterEach(() => resetDiagnosticEventsForTest());

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  payload: unknown,
  delivery: "wire" | "shared" | "internal" | "error" | "unavailable" | "serialization" = "wire",
) {
  const events: Extract<DiagnosticEventPayload, { type: "gateway.rpc"; phase: "response" }>[] = [];
  onTestFinished(
    onInternalDiagnosticEvent(
      (event) => {
        if (event.type === "gateway.rpc" && event.phase === "response") {
          events.push(event);
        }
      },
      { include: ["gateway.rpc"] },
    ),
  );
  const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
    respond(delivery !== "error", payload),
  );
  const harness = createDispatchTestHarness({ extraHandlers: { [method]: handler } });
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
    client.authenticatedUserProfile = {
      profileId: "private-profile",
      displayName: "Test operator",
      hasAvatar: false,
      avatarRevision: "0",
      updatedAt: 0,
    };
  }
  const request = { type: "req", id: "private-request", method, params };
  await harness.dispatcher.dispatch(
    request,
    client,
    undefined,
    delivery === "internal" ? (frame) => harness.send(frame) : undefined,
  );
  if (delivery === "shared") {
    await harness.dispatcher.dispatch({ ...request, id: "private-follower" }, client);
    expect(handler).toHaveBeenCalledOnce();
    for (const [frame] of harness.send.mock.calls) {
      expect(JSON.parse(serializeGatewayFrame(frame).toString()).payload).toEqual(payload);
    }
  }
  await waitForDiagnosticEventsDrained();
  return events;
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
      expect(events).toHaveLength(delivery === "shared" ? 2 : 1);
      for (const event of events) {
        expect(event.sessionsList).toMatchObject({
          rowsOutcome: "full-with-base",
          baseMissReason: reason,
        });
      }
    }
    const noBase = shareSidebarSessionRows(changed);
    const events = await dispatch("sessions.list", { rowMode: "sidebar" }, noBase, delivery);
    expect(events[0]?.sessionsList).not.toHaveProperty("baseMissReason");
  },
);

it.each([
  {
    params: { rowMode: "sidebar", ifRowsRevision: "private-revision" },
    payload: { rowsUnchanged: true },
    rowsOutcome: "unchanged",
  },
  {
    params: { rowMode: "sidebar", ifRowsRevision: "delta:private-revision" },
    payload: { rowsDelta: { baseRevision: "private-revision" } },
    rowsOutcome: "delta",
  },
  { params: { rowMode: "sidebar" }, payload: { sessions: [] }, rowsOutcome: "full-no-base" },
  {
    params: { rowMode: "sidebar", ifRowsRevision: "delta:private-revision" },
    payload: { sessions: [] },
    rowsOutcome: "full-with-base",
  },
  {
    params: { rowMode: "sidebar", ifRowsRevision: "private-revision" },
    payload: { sessions: [] },
    rowsOutcome: "full-with-base",
  },
  { params: { rowMode: "compact" }, payload: { sessions: [] }, rowsOutcome: "not-sidebar" },
  {
    params: { rowMode: "compact", ifRowsRevision: "" },
    payload: { sessions: [] },
    rowsOutcome: "full-no-base",
  },
  {
    params: { rowMode: "compact", ifRowsRevision: "private-revision" },
    payload: { rowsUnchanged: true },
    rowsOutcome: "unchanged",
  },
  {
    params: { rowMode: "compact", ifRowsRevision: "delta:private-revision" },
    payload: { rowsDelta: { baseRevision: "private-revision" } },
    rowsOutcome: "delta",
  },
])(
  "attributes session response bytes as $rowsOutcome",
  async ({ params, payload, rowsOutcome }) => {
    for (const delivery of ["wire", "shared"] as const) {
      const events = await dispatch(
        "sessions.list",
        { ...params, source: "sidebar" },
        payload,
        delivery,
      );
      const expected = {
        responseBytes: 1234,
        sessionsList: {
          clientKind: "openclaw-control-ui",
          source: "wire",
          callerSource: "sidebar",
          rowMode: params.rowMode,
          filter: "general",
          rowsOutcome,
        },
      };
      expect(events).toMatchObject(delivery === "shared" ? [expected, expected] : [expected]);
      expect(JSON.stringify(events)).not.toContain("private-");
    }
  },
);

it.each([
  {
    params: { cursor: "private-cursor", limit: 20 },
    kind: "delta",
    shape: "cursor",
    limitBucket: "<=20",
  },
  { params: { offset: 1, limit: 21 }, kind: undefined, shape: "older", limitBucket: "<=80" },
  {
    params: { pendingBefore: 2, offset: 1, limit: 80 },
    kind: undefined,
    shape: "pending",
    limitBucket: "<=80",
  },
  {
    params: { inputRunIds: ["private-run"], cursor: "private-cursor", pendingBefore: 2, limit: 81 },
    kind: "reset",
    shape: "receipt",
    limitBucket: "<=200",
  },
  { params: { offset: 0 }, kind: undefined, shape: "tail", limitBucket: "<=200" },
  {
    params: { messageId: "private-anchor", sessionId: "private-archive" },
    kind: undefined,
    shape: "anchor",
    limitBucket: "<=200",
  },
  { params: { limit: 201 }, kind: undefined, shape: "tail", limitBucket: ">200" },
])(
  "attributes validated history response shape $shape/$limitBucket",
  async ({ params, kind, shape, limitBucket }) => {
    const events = await dispatch(
      "chat.history",
      { sessionKey: "private-session", ...params },
      { kind },
    );
    expect(events).toMatchObject([
      {
        responseBytes: 1234,
        chatHistory: {
          clientKind: "openclaw-control-ui",
          source: "wire",
          shape,
          limitBucket,
          outcome: kind ?? "page",
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private-");
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
