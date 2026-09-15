// @vitest-environment node
import { expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  ACTIVITY_SUMMARY_ENSURE_METHOD,
  SessionActivityController,
} from "./session-activity-controller.ts";

const filters = { personId: null, time: "all" as const, query: "" };
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
const listing = (sessions: GatewaySessionRow[]): SessionsListResult => ({
  ts: 1,
  path: "",
  count: sessions.length,
  totalCount: sessions.length,
  sessions,
  defaults: { model: null, modelProvider: null, contextTokens: null },
});
const controller = () =>
  new SessionActivityController({
    addController() {},
    removeController() {},
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  });

it("backfills eligible mixed rows and refuses retries for visible read-only sessions", async () => {
  const sessions = [
    row("agent:main:owned"),
    row("agent:main:member"),
    row("agent:main:viewer", {
      sharingRole: "viewer",
      visibility: "shared",
      activitySummary: { state: "stale", text: "Cached foreign recap", canEnsure: false },
    }),
  ];
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const request = vi.spyOn(client, "request").mockImplementation(async (method, params) => {
    if (method === "sessions.list") {
      return listing(sessions);
    }
    const batch = (params as { sessions: Array<{ key: string }> }).sessions;
    expect(batch.map(({ key }) => key)).toEqual(sessions.slice(0, 2).map(({ key }) => key));
    return {
      sessions: batch.map(({ key }) => ({
        key,
        agentId: "main",
        activitySummary: { state: "updating", canEnsure: true },
      })),
    };
  });
  const state = controller();
  state.load(client, filters, "query", true);
  await vi.waitFor(() =>
    expect(state.result?.sessions[0]?.activitySummary?.state).toBe("updating"),
  );
  state.retrySummary(state.result!.sessions[2]!);
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(2);
  expect(state.result?.sessions[2]?.activitySummary).toEqual(sessions[2]!.activitySummary);
  state.hostDisconnected();
});

it("rechecks latest row permissions before queued batches and does not consume skipped attempts", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const sessions = Array.from({ length: 22 }, (_, index) => row(`agent:main:notes-${index}`));
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  let currentRows = sessions;
  const batches: string[][] = [];
  const request = vi.spyOn(client, "request").mockImplementation(async (method, params) => {
    if (method === "sessions.list") {
      return listing(currentRows);
    }
    const batch = (params as { sessions: Array<{ key: string }> }).sessions;
    batches.push(batch.map(({ key }) => key));
    if (batches.length === 1) {
      return pending;
    }
    return {
      sessions: batch.map(({ key }) => ({
        key,
        agentId: "main",
        activitySummary: { state: "updating", canEnsure: true },
      })),
    };
  });
  const state = controller();
  state.load(client, filters, "query", true);
  await vi.waitFor(() => expect(batches).toHaveLength(1));
  const staleRow = sessions[20]!;
  currentRows = sessions.map((session, index) => ({
    ...session,
    activitySummary: {
      state: index < 20 ? ("updating" as const) : ("stale" as const),
      canEnsure: index !== 20,
    },
  }));
  state.load(client, filters, "refresh");
  await vi.waitFor(() => expect(state.result?.sessions[20]).toEqual(currentRows[20]));
  state.retrySummary(staleRow);
  state.retrySummary(state.result!.sessions[20]!);
  finish({ sessions: [] });
  await vi.waitFor(() => expect(batches).toHaveLength(2));
  expect(batches[1]).toEqual([sessions[21]!.key]);
  currentRows = state.result!.sessions.map((session) =>
    Object.assign({}, session, {
      activitySummary: Object.assign({}, session.activitySummary, { canEnsure: true }),
    }),
  );
  state.load(client, filters, "refresh");
  await vi.waitFor(() => expect(batches).toHaveLength(3));
  expect(batches[2]).toEqual([staleRow.key]);
  expect(request).toHaveBeenCalledTimes(6);
  state.hostDisconnected();
});

it("backfills visible missing recaps in bounded batches without repeating reads or reordering sessions", async () => {
  const sessions = Array.from({ length: 25 }, (_, index) => row(`agent:main:notes-${index}`));
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const batches: Array<Array<{ key: string; agentId?: string }>> = [];
  vi.spyOn(client, "request").mockImplementation(async (method, params) => {
    if (method === "sessions.list") {
      return listing(sessions);
    }
    expect(method).toBe(ACTIVITY_SUMMARY_ENSURE_METHOD);
    const batch = (params as { sessions: Array<{ key: string; agentId?: string }> }).sessions;
    batches.push(batch);
    return {
      sessions: batch.map(({ key, agentId }) => ({
        key,
        agentId,
        activitySummary: { state: "updating", canEnsure: true },
      })),
    };
  });
  const state = controller();
  state.load(client, filters, "query", true);
  await vi.waitFor(() =>
    expect(
      state.result?.sessions.every((entry) => entry.activitySummary?.state === "updating"),
    ).toBe(true),
  );
  expect(batches.map((batch) => batch.length)).toEqual([20, 5]);
  expect(state.result?.sessions.map((entry) => entry.key)).toEqual(
    sessions.map((entry) => entry.key),
  );
  expect(state.result?.totalCount).toBe(25);
  state.load(client, filters);
  expect(batches).toHaveLength(2);
  state.hostDisconnected();
});

it("keeps cached recaps readable without requesting generation on a read-only connection", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const result = listing([
    row(),
    row("agent:main:cached", {
      activitySummary: {
        state: "stale",
        canEnsure: true,
        text: "Verified the repair; rollout remains pending.",
        updatedAt: 1,
      },
    }),
  ]);
  const request = vi.spyOn(client, "request").mockResolvedValue(result);
  const state = controller();
  state.load(client, filters, "query", false);
  await vi.waitFor(() => expect(state.result).toEqual(result));
  state.retrySummary(state.result!.sessions[1]!);
  expect(request).toHaveBeenCalledTimes(1);
  state.hostDisconnected();
});

it("does not let a delayed backfill response overwrite a newer session-list recap", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const oldRow = row();
  const newRow = row(oldRow.key, {
    updatedAt: 2,
    activitySummary: { state: "current", text: "The repair is now merged.", updatedAt: 2 },
  });
  const request = vi
    .spyOn(client, "request")
    .mockResolvedValueOnce(listing([oldRow]))
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(listing([newRow]));
  const state = controller();
  state.load(client, filters, "query", true);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  state.load(client, filters, "refresh");
  await vi.waitFor(() => expect(state.result?.sessions[0]).toEqual(newRow));
  finish({ sessions: [{ ...oldRow, activitySummary: { state: "updating", canEnsure: true } }] });
  await pending;
  await Promise.resolve();
  expect(state.result?.sessions[0]).toEqual(newRow);
  state.hostDisconnected();
});

it("backfills newly visible sessions after the current batch settles", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const first = row();
  const added = row("agent:main:newly-visible");
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const request = vi
    .spyOn(client, "request")
    .mockResolvedValueOnce(listing([first]))
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(listing([first, added]))
    .mockResolvedValueOnce({
      sessions: [{ ...added, activitySummary: { state: "updating", canEnsure: true } }],
    });
  const state = controller();
  try {
    state.load(client, filters, "query", true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    state.load(client, filters, "refresh");
    await vi.waitFor(() => expect(state.result?.sessions).toEqual([first, added]));
    finish({
      sessions: [{ ...first, activitySummary: { state: "updating", canEnsure: true } }],
    });
    await vi.waitFor(() =>
      expect(state.result?.sessions[1]?.activitySummary?.state).toBe("updating"),
    );
    expect(request).toHaveBeenLastCalledWith(
      ACTIVITY_SUMMARY_ENSURE_METHOD,
      { sessions: [{ key: added.key, agentId: added.agentId }] },
      expect.anything(),
    );
    expect(request).toHaveBeenCalledTimes(4);
  } finally {
    finish({ sessions: [] });
    state.hostDisconnected();
    await pending;
  }
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
      method === "sessions.list"
        ? listing([source])
        : {
            sessions: [{ ...source, activitySummary: { state: "updating", canEnsure: true } }],
          };
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    let held = false;
    const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
    const request = vi.spyOn(client, "request").mockImplementation(async (method) => {
      if (method === heldMethod && !held) {
        held = true;
        return pending;
      }
      return response(method);
    });
    const state = controller();
    try {
      state.hostConnected();
      state.load(client, filters, "query", true);
      await vi.waitFor(() => expect(held).toBe(true));
      if (visibilityState !== "hidden") {
        visibilityState = "hidden";
        documentEvents.dispatchEvent(new Event("visibilitychange"));
      }
      finish(response(heldMethod));
      await vi.waitFor(() => expect(state.loading).toBe(false));
      const requestsWhileHidden = heldMethod === "sessions.list" ? 1 : 2;
      expect(request).toHaveBeenCalledTimes(requestsWhileHidden);
      expect(state.result?.sessions[0]?.activitySummary?.state).toBe("stale");

      visibilityState = "visible";
      documentEvents.dispatchEvent(new Event("visibilitychange"));
      await vi.waitFor(() =>
        expect(state.result?.sessions[0]?.activitySummary?.state).toBe("updating"),
      );
    } finally {
      finish(response(heldMethod));
      state.hostDisconnected();
      await pending;
      vi.unstubAllGlobals();
    }
  },
);

it("retains a failed recap and retries it without turning the session list into an error", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const source = row(undefined, {
    activitySummary: {
      state: "stale",
      canEnsure: true,
      text: "Found the failure; verification remains.",
      updatedAt: 1,
    },
  });
  const request = vi
    .spyOn(client, "request")
    .mockResolvedValueOnce(listing([source]))
    .mockRejectedValueOnce(new Error("Network interrupted"))
    .mockResolvedValueOnce({
      sessions: [{ ...source, activitySummary: { ...source.activitySummary, state: "updating" } }],
    });
  const state = controller();
  state.load(client, filters, "query", true);
  await vi.waitFor(() =>
    expect(state.result?.sessions[0]?.activitySummary?.state).toBe("unavailable"),
  );
  expect(state.result?.sessions[0]?.activitySummary?.text).toBe(source.activitySummary?.text);
  expect(state.error).toBeUndefined();
  state.retrySummary(state.result!.sessions[0]!);
  await vi.waitFor(() =>
    expect(state.result?.sessions[0]?.activitySummary?.state).toBe("updating"),
  );
  expect(request).toHaveBeenCalledTimes(3);
  state.hostDisconnected();
});

it("stops queued backfill batches when write access is revoked", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const sessions = Array.from({ length: 25 }, (_, index) => row(`agent:main:notes-${index}`));
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const request = vi
    .spyOn(client, "request")
    .mockResolvedValueOnce(listing(sessions))
    .mockReturnValueOnce(pending);
  const state = controller();
  state.load(client, filters, "query", true);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  state.load(client, filters, "query", false);
  finish({
    sessions: sessions.slice(0, 20).map(({ key, agentId }) => ({
      key,
      agentId,
      activitySummary: { state: "updating", canEnsure: true },
    })),
  });
  await pending;
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(2);
  expect(state.result?.sessions).toEqual(sessions);
  state.hostDisconnected();
});

it("keeps an explicit retry queued while another visible batch is pending", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const retryRow = row("agent:main:retry", {
    activitySummary: {
      state: "unavailable",
      text: "Previous recap",
      updatedAt: 1,
      canEnsure: true,
    },
  });
  const pendingRow = row();
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const request = vi
    .spyOn(client, "request")
    .mockResolvedValueOnce(listing([retryRow, pendingRow]))
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce({
      sessions: [
        { ...retryRow, activitySummary: { ...retryRow.activitySummary, state: "updating" } },
      ],
    });
  const state = controller();
  state.load(client, filters, "query", true);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  state.retrySummary(state.result!.sessions[0]!);
  finish({
    sessions: [{ ...pendingRow, activitySummary: { state: "updating", canEnsure: true } }],
  });
  await vi.waitFor(() =>
    expect(state.result?.sessions[0]?.activitySummary?.state).toBe("updating"),
  );
  expect(request).toHaveBeenLastCalledWith(
    ACTIVITY_SUMMARY_ENSURE_METHOD,
    { sessions: [{ key: retryRow.key, agentId: "main" }] },
    expect.anything(),
  );
  state.hostDisconnected();
});
