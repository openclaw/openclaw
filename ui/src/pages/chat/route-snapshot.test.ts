// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createApplicationRouter, startApplicationRouter } from "../../app-routes.ts";
import { loadChatRoute } from "./route-loader.ts";
import {
  createSessionRouteContext,
  createSessionRouteRow,
  sessionRouteListResult,
  sessionRouteKey,
  sessionRouteUuid,
} from "./route-resolution.test-support.ts";
import * as database from "./session-snapshot-database.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { prewarmChatSnapshot } from "./session-snapshot-prewarm.ts";
import { readPrewarmedChatSnapshot, SessionSnapshotStore } from "./session-snapshot-store.ts";

const scope = (host = "snapshot.example", account = "account-a") =>
  `scope:["ws://${host}","${account}"]\u0000`;
const prefix = scope();
const snapshot = {
  messages: [{ role: "assistant", content: "Remembered transcript" }],
  sessionId: "stored-session",
  pagination: { hasMore: false, completeSnapshot: true } as const,
};
const locationFor = (id = sessionRouteUuid) => ({
  pathname: `/chat/roboclaw/${id}`,
  search: "",
  hash: "",
});
const resolveRoute = (context: Parameters<typeof loadChatRoute>[0], id = sessionRouteUuid) =>
  loadChatRoute(context, locationFor(id), "chat", new AbortController().signal);

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(async () => {
  await clearStoredChatSnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(key = sessionRouteKey, storedPrefix = prefix) {
  const store = new SessionSnapshotStore();
  store.write(storedPrefix + key, snapshot);
  await store.flush();
  void prewarmChatSnapshot(storedPrefix + key);
  const fixture = createSessionRouteContext();
  Object.defineProperty(fixture.context.gateway, "connection", {
    value: { gatewayUrl: "ws://snapshot.example" },
  });
  Object.assign(fixture.context.gateway.snapshot.client!, { offlineRecoveryScope: "account-a" });
  return fixture;
}

it("keeps cached roster admission ahead of a prewarmed full-UUID snapshot", async () => {
  const { context, request } = await setup();
  await context.sessions.whenCachedRosterSettled();
  context.gateway.snapshot.phase = "connecting";
  context.sessions.state.result = sessionRouteListResult([createSessionRouteRow()]);
  context.sessions.state.resultCached = true;
  Object.defineProperty(context.sessions, "cachedRoutingDefaults", {
    value: { mainKey: "main", scope: "per-sender" },
  });
  const result = await resolveRoute(context, sessionRouteUuid.replaceAll("-", ""));
  expect(result).toMatchObject({
    kind: "session",
    sessionKey: sessionRouteKey,
    sessionResolutionFromCache: "roster",
  });
  expect(request).not.toHaveBeenCalled();
});

it.each([sessionRouteUuid, sessionRouteUuid.replaceAll("-", "")])(
  "admits an off-roster full UUID %s from the scoped snapshot and leaves it for the pane",
  async (id) => {
    const { context, request } = await setup();
    request.mockImplementation(() => {
      throw new Error("Snapshot admission must not read authority");
    });
    const result = await resolveRoute(context, id);
    expect(result).toMatchObject({
      kind: "session",
      sessionKey: sessionRouteKey,
      sessionResolutionFromCache: "snapshot",
    });
    expect(result).not.toHaveProperty("canonicalLocation");
    expect(request).not.toHaveBeenCalled();
    expect(await readPrewarmedChatSnapshot(prefix + sessionRouteKey)).toEqual(snapshot);
  },
);

it.each([
  ["other account", sessionRouteKey, scope("snapshot.example", "account-b"), sessionRouteUuid],
  ["other host", sessionRouteKey, scope("other.example"), sessionRouteUuid],
  ["other agent", sessionRouteKey.replace("roboclaw", "other"), prefix, sessionRouteUuid],
  ["different UUID", sessionRouteKey.replace("12345678", "87654321"), prefix, sessionRouteUuid],
  ["short prefix", sessionRouteKey, prefix, "12345678"],
  ["slug only", sessionRouteKey, prefix, "remembered-transcript"],
])("waits for authority with %s", async (_name, key, storedPrefix, id) => {
  const { context, request } = await setup(key, storedPrefix);
  request.mockResolvedValue({ ok: false });
  const result = await resolveRoute(context, id);
  expect(result).toMatchObject({ kind: "missing-session" });
  expect(request).toHaveBeenCalled();
});

it.each(["reconnect", "account change"])(
  "does not admit a snapshot across %s during its read",
  async (change) => {
    const held = createDeferred<unknown>();
    const read = database.readStoredChatSnapshotRecord;
    vi.spyOn(database, "readStoredChatSnapshotRecord").mockReturnValueOnce(held.promise);
    const { context, request } = await setup();
    let revision = 0;
    Object.defineProperty(context.gateway, "connectionRevision", { get: () => revision });
    const loading = resolveRoute(context);
    await vi.dynamicImportSettled();
    if (change === "reconnect") {
      revision++;
    } else {
      Object.assign(context.gateway.snapshot.client!, { offlineRecoveryScope: "account-b" });
    }
    held.resolve(await read(prefix + sessionRouteKey));
    expect(await loading).toMatchObject({ kind: "missing-session" });
    expect(request).toHaveBeenCalled();
  },
);

it.each([false, true])(
  "revalidates cached admission through the router after hello (deleted: %s)",
  async (deleted) => {
    const { context, request } = await setup();
    const answer = createDeferred<unknown>();
    request.mockImplementation(() => answer.promise);
    const router = createApplicationRouter();
    context.router = router;
    onTestFinished(() => router.stop());
    vi.spyOn(router.getRoute("chat")!, "component").mockResolvedValue({ renderSolid: () => null });
    const location = locationFor();
    const startup = startApplicationRouter(
      router,
      {
        location: () => location,
        push: () => {},
        replace: () => {},
        listen: () => () => {},
      },
      "",
      context,
    );
    await startup;
    await vi.dynamicImportSettled();
    expect(request).toHaveBeenCalledOnce();
    expect(router.getState().matches[0]?.data).toMatchObject({
      kind: "session",
      sessionKey: sessionRouteKey,
    });
    answer.resolve(deleted ? { ok: false } : { ok: true, key: sessionRouteKey });
    await vi.dynamicImportSettled();
    expect(router.getState().matches[0]?.data).toMatchObject(
      deleted ? { kind: "missing-session" } : { kind: "session", sessionKey: sessionRouteKey },
    );
    expect(router.getState().matches[0]?.data).not.toHaveProperty("sessionResolutionFromCache");
    expect(request).toHaveBeenCalledOnce();
  },
);
