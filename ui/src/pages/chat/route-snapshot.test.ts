// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createApplicationRouter, startApplicationRouter } from "../../app-routes.ts";
import { loadChatRoute } from "./route-loader.ts";
import {
  createSessionRouteContext,
  sessionRouteKey,
  sessionRouteUuid,
} from "./route-resolution.test-support.ts";
import * as database from "./session-snapshot-database.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { prewarmChatSnapshot } from "./session-snapshot-prewarm.ts";
import { readPrewarmedChatSnapshot, SessionSnapshotStore } from "./session-snapshot-store.ts";

const prefix = 'scope:["ws://snapshot.example","account-a"]\u0000';
const snapshot = {
  messages: [{ role: "assistant", content: "Remembered transcript" }],
  sessionId: "stored-session",
  pagination: { hasMore: false, completeSnapshot: true } as const,
};

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
  prewarmChatSnapshot(storedPrefix + key);
  const fixture = createSessionRouteContext();
  Object.defineProperty(fixture.context.gateway, "connection", {
    value: { gatewayUrl: "ws://snapshot.example" },
  });
  Object.assign(fixture.context.gateway.snapshot.client!, { offlineRecoveryScope: "account-a" });
  return fixture;
}

it.each([sessionRouteUuid, sessionRouteUuid.replaceAll("-", "")])(
  "admits an off-roster full UUID %s from the scoped snapshot and leaves it for the pane",
  async (id) => {
    const { context, request } = await setup();
    const resolving = createDeferred<"waiting for resolve">();
    request.mockImplementation(() => {
      resolving.resolve("waiting for resolve");
      return new Promise(() => {});
    });
    const result = await Promise.race([
      loadChatRoute(
        context,
        { pathname: `/chat/roboclaw/${id}`, search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
      resolving.promise,
    ]);
    expect(result).toMatchObject({
      kind: "session",
      sessionKey: sessionRouteKey,
      sessionResolutionFromCache: "snapshot",
    });
    expect(result).not.toHaveProperty("canonicalLocation");
    expect(request).not.toHaveBeenCalled();
    const prewarmed = await readPrewarmedChatSnapshot(prefix + sessionRouteKey);
    expect(prewarmed).toEqual(snapshot);
    expect(await new SessionSnapshotStore().read(prefix + sessionRouteKey)).toBe(prewarmed);
  },
);

it.each([
  [
    "other account",
    sessionRouteKey,
    'scope:["ws://snapshot.example","account-b"]\u0000',
    sessionRouteUuid,
  ],
  [
    "other host",
    sessionRouteKey,
    'scope:["ws://other.example","account-a"]\u0000',
    sessionRouteUuid,
  ],
  ["other agent", sessionRouteKey.replace("roboclaw", "other"), prefix, sessionRouteUuid],
  ["different UUID", sessionRouteKey.replace("12345678", "87654321"), prefix, sessionRouteUuid],
  ["short prefix", sessionRouteKey, prefix, "12345678"],
  ["slug only", sessionRouteKey, prefix, "remembered-transcript"],
])("waits for authority with %s", async (_name, key, storedPrefix, id) => {
  const { context, request } = await setup(key, storedPrefix);
  request.mockResolvedValue({ ok: false });
  const result = await loadChatRoute(
    context,
    { pathname: `/chat/roboclaw/${id}`, search: "", hash: "" },
    "chat",
    new AbortController().signal,
  );
  expect(result).toMatchObject({ kind: "missing-session" });
  expect(request).toHaveBeenCalled();
});

it.each([
  { response: { ok: false }, expected: { kind: "missing-session" } },
  {
    response: { ok: true, key: `agent:other:thread:${sessionRouteUuid}`, agentId: "other" },
    expected: {
      kind: "session",
      sessionKey: `agent:other:thread:${sessionRouteUuid}`,
      agentId: "other",
    },
  },
])("replaces cached admission with $response", async ({ response, expected }) => {
  const { context, request } = await setup();
  const location = { pathname: `/chat/roboclaw/${sessionRouteUuid}`, search: "", hash: "" };
  const initial = await loadChatRoute(context, location, "chat", new AbortController().signal);
  expect(initial).toMatchObject({ kind: "session", sessionKey: sessionRouteKey });
  request.mockResolvedValue(response);
  const result = await loadChatRoute(context, location, "chat", new AbortController().signal, {
    sessionKey: sessionRouteKey,
  });
  expect(result).toMatchObject(expected);
  expect(result).not.toHaveProperty("sessionResolutionFromCache");
});

it("does not admit a snapshot across a reconnect during its read", async () => {
  const held = createDeferred<unknown>();
  const read = database.readStoredChatSnapshotRecord;
  vi.spyOn(database, "readStoredChatSnapshotRecord").mockReturnValueOnce(held.promise);
  const { context, request } = await setup();
  let revision = 0;
  Object.defineProperty(context.gateway, "connectionRevision", { get: () => revision });
  const loading = loadChatRoute(
    context,
    { pathname: `/chat/roboclaw/${sessionRouteUuid}`, search: "", hash: "" },
    "chat",
    new AbortController().signal,
  );
  await vi.dynamicImportSettled();
  revision++;
  held.resolve(await read(prefix + sessionRouteKey));
  expect(await loading).toMatchObject({ kind: "missing-session" });
  expect(request).toHaveBeenCalled();
});

it.each([false, true])(
  "revalidates cached admission through the router after hello (deleted: %s)",
  async (deleted) => {
    const { context, request } = await setup();
    const answer = createDeferred<unknown>();
    request.mockImplementation(() => {
      return answer.promise;
    });
    const router = createApplicationRouter();
    context.router = router;
    onTestFinished(() => router.stop());
    vi.spyOn(router.getRoute("chat")!, "component").mockResolvedValue({ renderSolid: () => null });
    const location = { pathname: `/chat/roboclaw/${sessionRouteUuid}`, search: "", hash: "" };
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
    expect(request).toHaveBeenCalledOnce();
  },
);
