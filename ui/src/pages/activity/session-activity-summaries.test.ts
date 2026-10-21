// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { sessionActivityListing } from "./session-activity-controller.test-support.ts";
import { ACTIVITY_SUMMARY_ENSURE_METHOD, createSessionActivity } from "./session-activity-owner.ts";

const filters = { personId: null, time: "all" as const, query: "" };
const recap = (text: string, state: "stale" | "unavailable" = "stale") => ({
  state,
  canEnsure: true,
  text,
  updatedAt: 1,
});
const row = (
  key = "agent:main:notes",
  overrides: Partial<GatewaySessionRow> = {},
): GatewaySessionRow => ({
  key,
  agentId: "main",
  sessionId: key,
  kind: "direct",
  updatedAt: 1,
  activitySummary: { state: "stale", canEnsure: true },
  ...overrides,
});
const listing = (sessions: GatewaySessionRow[]) =>
  sessionActivityListing(sessions, { totalCount: sessions.length });
const updating = (...sessions: GatewaySessionRow[]) => ({
  sessions: sessions.map(({ key, agentId, activitySummary }) => ({
    key,
    agentId,
    activitySummary: { ...activitySummary, state: "updating", canEnsure: true },
  })),
});
type BackfillResponse = SessionsListResult | ReturnType<typeof updating>;
let client: GatewayBrowserClient;
let state: ReturnType<typeof createSessionActivity>;
let request: ReturnType<typeof mockRequest>;
let held: ReturnType<typeof createDeferred<BackfillResponse>>;
const mockRequest = () => vi.spyOn(client, "request");
const waitForSummary = (index: number, value: string) =>
  vi.waitFor(() => expect(state.result?.sessions[index]?.activitySummary?.state).toBe(value));
const startBackfill = async (sessions: GatewaySessionRow[], ...responses: BackfillResponse[]) => {
  request.mockResolvedValueOnce(listing(sessions)).mockReturnValueOnce(held.promise);
  for (const response of responses) {
    request.mockResolvedValueOnce(response);
  }
  void state.load(client, filters, "query", true);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
};
const expectEnsure = (session: GatewaySessionRow) =>
  expect(request).toHaveBeenLastCalledWith(
    ACTIVITY_SUMMARY_ENSURE_METHOD,
    { sessions: [{ key: session.key, agentId: session.agentId }] },
    expect.anything(),
  );
beforeEach(() => {
  client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  state = createSessionActivity(() => {});
  request = mockRequest();
  held = createDeferred<BackfillResponse>();
});
afterEach(async () => {
  held.resolve({ sessions: [] });
  state.dispose();
  await held.promise;
  vi.unstubAllGlobals();
});

it("rechecks latest row permissions before queued batches and does not consume skipped attempts", async () => {
  const sessions = Array.from({ length: 22 }, (_, index) => row(`agent:main:notes-${index}`));
  let currentRows = sessions;
  const batches: string[][] = [];
  request.mockImplementation(async (method, params) => {
    if (method === "sessions.list") {
      return listing(currentRows);
    }
    const batch = (params as { sessions: Array<{ key: string }> }).sessions;
    batches.push(batch.map(({ key }) => key));
    if (batches.length === 1) {
      return held.promise;
    }
    return updating(...batch.map(({ key }) => row(key)));
  });
  void state.load(client, filters, "query", true);
  await vi.waitFor(() => expect(batches).toHaveLength(1));
  expect(batches[0]).toHaveLength(20);
  const staleRow = sessions[20]!;
  currentRows = sessions.map((session, index) => ({
    ...session,
    activitySummary: {
      state: index < 20 ? ("updating" as const) : ("stale" as const),
      canEnsure: index !== 20,
    },
  }));
  void state.load(client, filters, "refresh");
  await vi.waitFor(() => expect(state.result?.sessions[20]).toEqual(currentRows[20]));
  state.retrySummary(staleRow);
  state.retrySummary(state.result!.sessions[20]!);
  held.resolve({ sessions: [] });
  await vi.waitFor(() => expect(batches).toHaveLength(2));
  expect(batches[1]).toEqual([sessions[21]!.key]);
  currentRows = state.result!.sessions.map((session) =>
    Object.assign({}, session, {
      activitySummary: Object.assign({}, session.activitySummary, { canEnsure: true }),
    }),
  );
  void state.load(client, filters, "refresh");
  await vi.waitFor(() => expect(batches).toHaveLength(3));
  expect(batches[2]).toEqual([staleRow.key]);
  expect(request).toHaveBeenCalledTimes(6);
});

it("keeps cached recaps readable without requesting generation on a read-only connection", async () => {
  const result = listing([
    row(),
    row("agent:main:cached", {
      activitySummary: recap("Verified the repair; rollout remains pending."),
    }),
  ]);
  request.mockResolvedValue(result);
  void state.load(client, filters, "query", false);
  await vi.waitFor(() => expect(state.result).toEqual(result));
  state.retrySummary(state.result!.sessions[1]!);
  expect(request).toHaveBeenCalledTimes(1);
});

it("does not let a delayed backfill response overwrite a newer session-list recap", async () => {
  const oldRow = row();
  const newRow = row(oldRow.key, {
    updatedAt: 2,
    activitySummary: { state: "current", text: "The repair is now merged.", updatedAt: 2 },
  });
  await startBackfill([oldRow], listing([newRow]));
  void state.load(client, filters, "refresh");
  await vi.waitFor(() => expect(state.result?.sessions[0]).toEqual(newRow));
  held.resolve(updating(oldRow));
  await held.promise;
  await Promise.resolve();
  expect(state.result?.sessions[0]).toEqual(newRow);
});

it("backfills newly visible sessions after the current batch settles", async () => {
  const first = row();
  const added = row("agent:main:newly-visible");
  await startBackfill([first], listing([first, added]), updating(added));
  void state.load(client, filters, "refresh");
  await vi.waitFor(() => expect(state.result?.sessions).toEqual([first, added]));
  held.resolve(updating(first));
  await waitForSummary(1, "updating");
  expectEnsure(added);
  expect(request).toHaveBeenCalledTimes(4);
});

it.each(["sessions.list", ACTIVITY_SUMMARY_ENSURE_METHOD])(
  "resumes recap generation after %s finishes in a hidden tab",
  async (heldMethod) => {
    const documentEvents = new EventTarget();
    const pageEvents = new EventTarget();
    let visibilityState = heldMethod === "sessions.list" ? "hidden" : "visible";
    Object.defineProperty(documentEvents, "visibilityState", { get: () => visibilityState });
    vi.stubGlobal("document", documentEvents);
    vi.stubGlobal("addEventListener", pageEvents.addEventListener.bind(pageEvents));
    vi.stubGlobal("removeEventListener", pageEvents.removeEventListener.bind(pageEvents));
    const source = row();
    const response = (method: string) =>
      method === "sessions.list" ? listing([source]) : updating(source);
    let intercepted = false;
    request.mockImplementation(async (method) => {
      if (method === heldMethod && !intercepted) {
        intercepted = true;
        return held.promise;
      }
      return response(method);
    });
    state.dispose();
    state = createSessionActivity(() => {});
    void state.load(client, filters, "query", true);
    await vi.waitFor(() => expect(intercepted).toBe(true));
    if (visibilityState !== "hidden") {
      visibilityState = "hidden";
      documentEvents.dispatchEvent(new Event("visibilitychange"));
    }
    held.resolve(response(heldMethod));
    await vi.waitFor(() => expect(state.loading).toBe(false));
    const requestsWhileHidden = heldMethod === "sessions.list" ? 1 : 2;
    expect(request).toHaveBeenCalledTimes(requestsWhileHidden);
    expect(state.result?.sessions[0]?.activitySummary?.state).toBe("stale");
    visibilityState = "visible";
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    await waitForSummary(0, "updating");
  },
);

it("retains a failed recap and retries it without turning the session list into an error", async () => {
  const source = row(undefined, {
    activitySummary: recap("Found the failure; verification remains."),
  });
  request
    .mockResolvedValueOnce(listing([source]))
    .mockRejectedValueOnce(new Error("Network interrupted"))
    .mockResolvedValueOnce(updating(source));
  void state.load(client, filters, "query", true);
  await waitForSummary(0, "unavailable");
  expect(state.result?.sessions[0]?.activitySummary?.text).toBe(source.activitySummary?.text);
  expect(state.error).toBeUndefined();
  state.retrySummary(state.result!.sessions[0]!);
  await waitForSummary(0, "updating");
  expect(request).toHaveBeenCalledTimes(3);
});

it("stops queued backfill batches when write access is revoked", async () => {
  const sessions = Array.from({ length: 25 }, (_, index) => row(`agent:main:notes-${index}`));
  await startBackfill(sessions);
  void state.load(client, filters, "query", false);
  held.resolve(updating(...sessions.slice(0, 20)));
  await held.promise;
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(2);
  expect(state.result?.sessions).toEqual(sessions);
});

it("keeps an explicit retry queued while another visible batch is pending", async () => {
  const retryRow = row("agent:main:retry", {
    activitySummary: recap("Previous recap", "unavailable"),
  });
  const pendingRow = row();
  await startBackfill([retryRow, pendingRow], updating(retryRow));
  state.retrySummary(state.result!.sessions[0]!);
  held.resolve(updating(pendingRow));
  await waitForSummary(0, "updating");
  expectEnsure(retryRow);
});
