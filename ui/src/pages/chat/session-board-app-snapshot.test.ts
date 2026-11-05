import type { BoardWidget } from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
/* @vitest-environment jsdom */
import { IDBObjectStore } from "fake-indexeddb";
import { assert, expect, it, vi } from "vitest";
import type { McpAppViewPayload } from "../../components/mcp-app-view-types.ts";
import { requestResult, transactionComplete } from "../../lib/chat/control-ui-database.runtime.ts";
import {
  BOARD_APP_SNAPSHOT_STORE_NAME,
  openSessionSnapshotDatabase,
} from "./session-snapshot-database.ts";
import {
  clearStoredChatSnapshots,
  deleteStoredChatSnapshot,
} from "./session-snapshot-invalidation.ts";
import { key, useSessionSnapshotStoreFixture } from "./session-snapshot-store.test-support.ts";

const { makeStore } = useSessionSnapshotStoreFixture();
const sessionKey = key("agent:main:dashboard:synthetic");
const widget: BoardWidget = {
  name: "metrics",
  instanceId: "pin-one",
  revision: 1,
  grantState: "granted",
  contentKind: "mcp-app",
  presentation: "frameless",
  tabId: "main",
  sizeW: 12,
  sizeH: 20,
  position: 0,
};
const payload = {
  html: "<!doctype html><main>Synthetic metrics</main>",
  sandboxUrl: "https://sandbox.example.test/app",
  sandboxPort: 443,
  sandboxOrigin: "https://sandbox.example.test",
  csp: {
    connectDomains: ["https://api.example.test"],
    resourceDomains: ["https://assets.example.test"],
    frameDomains: [],
  },
  messageSupported: true,
  updateModelContextSupported: true,
  richModelContextSupported: false,
  fileResourcesSupported: true,
  openFilesSupported: false,
  displayMode: "inline",
  displayModes: { availableDisplayModes: ["inline", "fullscreen"] },
  toolInput: { region: "synthetic" },
  toolResult: { content: [{ type: "text", text: "42" }], structuredContent: { total: 42 } },
  viewId: "synthetic-live-view-id",
  leaseId: "synthetic-live-lease-id",
  expiresAtMs: 123456789,
  grants: ["synthetic-live-authority"],
  hostContext: { "openai/deepLink": { url: "/synthetic-live-only-context" } },
} satisfies McpAppViewPayload & {
  viewId: string;
  leaseId: string;
  expiresAtMs: number;
  grants: string[];
};

async function rawRecords(update?: (value: Record<string, unknown>) => unknown) {
  const database = await openSessionSnapshotDatabase();
  assert(database);
  try {
    const transaction = database.transaction(BOARD_APP_SNAPSHOT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(BOARD_APP_SNAPSHOT_STORE_NAME);
    const values: unknown[] = await requestResult(store.getAll());
    if (update) {
      const record = asOptionalRecord(values[0]);
      assert(record);
      store.put(update(record));
    }
    await transactionComplete(transaction);
    return values;
  } finally {
    database.close();
  }
}

it("restores exact sandbox/CSP and complete replay data without persisting live authority", async () => {
  const writer = makeStore(undefined, true);
  await writer.boardAppDisplay(sessionKey, [widget], widget, payload);
  const restored = await makeStore(undefined, true).boardAppDisplay(sessionKey, [widget], widget);
  expect(restored).toMatchObject({
    html: "<!doctype html><main>Synthetic metrics</main>",
    sandboxUrl: "https://sandbox.example.test/app",
    sandboxPort: 443,
    sandboxOrigin: "https://sandbox.example.test",
    csp: {
      connectDomains: ["https://api.example.test"],
      resourceDomains: ["https://assets.example.test"],
      frameDomains: [],
    },
    toolInput: { region: "synthetic" },
    toolResult: { content: [{ type: "text", text: "42" }], structuredContent: { total: 42 } },
    messageSupported: true,
    updateModelContextSupported: true,
    richModelContextSupported: false,
    fileResourcesSupported: true,
    openFilesSupported: false,
    displayMode: "inline",
    displayModes: { availableDisplayModes: ["inline", "fullscreen"] },
  });
  const serialized = JSON.stringify(await rawRecords());
  for (const liveOnly of ["viewId", "leaseId", "expiresAtMs", "grants", "hostContext"])
    expect(serialized).not.toContain(liveOnly);
});

it.each([
  { name: "grant revocation", next: [{ ...widget, grantState: "rejected" as const }] },
  { name: "re-pin", next: [{ ...widget, instanceId: "pin-two" }] },
  { name: "revision", next: [{ ...widget, revision: 2 }] },
  { name: "removal", next: [] },
])("retires the prior display on $name", async ({ next }) => {
  const store = makeStore(undefined, true);
  await store.boardAppDisplay(sessionKey, [widget], widget, payload);
  await store.boardAppDisplay(sessionKey, next);
  expect(await rawRecords()).toEqual([]);
  expect(await store.boardAppDisplay(sessionKey, [widget], widget)).toBeNull();
});

it.each(["session", "scope", "sign-out"] as const)(
  "fences in-flight reads and removes persisted displays on %s invalidation",
  async (kind) => {
    const store = makeStore(undefined, true);
    const otherKey = 'scope:["wss://other.example","account-b"]\0agent:main:dashboard:other';
    const peerSessionKey = key("agent:main:dashboard:peer");
    await store.boardAppDisplay(sessionKey, [widget], widget, payload);
    await store.boardAppDisplay(otherKey, [widget], widget, payload);
    await store.boardAppDisplay(peerSessionKey, [widget], widget, payload);
    let invalidation: Promise<void> | undefined;
    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
    getAll.mockImplementationOnce(function (this: IDBObjectStore, ...args) {
      getAll.mockRestore();
      const request = this.getAll(...args);
      request.addEventListener("success", () => {
        invalidation =
          kind === "session"
            ? deleteStoredChatSnapshot(sessionKey)
            : clearStoredChatSnapshots(
                kind === "scope" ? sessionKey.slice(0, sessionKey.indexOf("\0") + 1) : undefined,
              );
      });
      return request;
    });
    const readingTarget = store.boardAppDisplay(sessionKey, [widget], widget);
    const readingPeer = store.boardAppDisplay(peerSessionKey, [widget], widget);
    expect(await readingTarget).toBeNull();
    expect(Boolean(await readingPeer)).toBe(kind === "session");
    assert(invalidation);
    await invalidation;
    expect(await store.boardAppDisplay(sessionKey, [widget], widget)).toBeNull();
    expect(Boolean(await store.boardAppDisplay(otherKey, [widget], widget))).toBe(
      kind !== "sign-out",
    );
  },
);

it.each([key("agent:main:dashboard:incognito-private"), "unowned:agent:main:dashboard:unscoped"])(
  "never persists excluded scope %s",
  async (excluded) => {
    const store = makeStore(undefined, true);
    expect(await store.boardAppDisplay(excluded, [widget], widget, payload)).toBeNull();
    expect(await store.boardAppDisplay(excluded, [widget], widget)).toBeNull();
    expect(await rawRecords()).toEqual([]);
  },
);

it("isolates account, session and widget identity", async () => {
  const store = makeStore(undefined, true);
  await store.boardAppDisplay(sessionKey, [widget], widget, payload);
  const scopes = [
    key("agent:main:dashboard:other-session"),
    'scope:["wss://cache.example","account-b"]\0agent:main:dashboard:synthetic',
  ];
  for (const other of scopes)
    expect(await store.boardAppDisplay(other, [widget], widget)).toBeNull();
  const otherWidget = { ...widget, name: "other-widget" };
  expect(await store.boardAppDisplay(sessionKey, [widget, otherWidget], otherWidget)).toBeNull();
  expect(await store.boardAppDisplay(sessionKey, [widget], widget)).not.toBeNull();
});

it("bounds eight records by actual write time rather than read time", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const store = makeStore(undefined, true);
  const widgets = Array.from({ length: 9 }, (_, index) => ({ ...widget, name: `app-${index}` }));
  for (const item of widgets.slice(0, 8)) {
    await store.boardAppDisplay(sessionKey, widgets, item, payload);
    now += 100;
  }
  await store.boardAppDisplay(sessionKey, widgets, widgets[0]);
  await store.boardAppDisplay(sessionKey, widgets, widgets[8], payload);
  expect(await rawRecords()).toHaveLength(8);
  expect(await store.boardAppDisplay(sessionKey, widgets, widgets[0])).toBeNull();
  now += 100;
  await store.boardAppDisplay(sessionKey, widgets, widgets[1], {
    ...payload,
    toolResult: { content: [{ type: "text", text: "43" }] },
  });
  now += 100;
  await store.boardAppDisplay(sessionKey, widgets, widgets[0], payload);
  expect(await store.boardAppDisplay(sessionKey, widgets, widgets[2])).toBeNull();
  expect(
    (await store.boardAppDisplay(sessionKey, widgets, widgets[1]))?.toolResult.content,
  ).toEqual([{ type: "text", text: "43" }]);
});

it("bounds total UTF-8 bytes independently of record count", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const store = makeStore(undefined, true);
  const widgets = Array.from({ length: 8 }, (_, index) => ({ ...widget, name: `large-${index}` }));
  for (const item of widgets) {
    await store.boardAppDisplay(sessionKey, widgets, item, {
      ...payload,
      html: "a".repeat(600 * 1024),
    });
    now += 100;
  }
  const records = await rawRecords();
  expect(records).toHaveLength(6);
  expect(
    records.reduce<number>(
      (sum, record) => sum + new TextEncoder().encode(JSON.stringify(record)).byteLength,
      0,
    ),
  ).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(await store.boardAppDisplay(sessionKey, widgets, widgets[0])).toBeNull();
  expect(await store.boardAppDisplay(sessionKey, widgets, widgets[7])).not.toBeNull();
});

it.each(["version", "display"] as const)("discards a mismatched cached %s", async (mismatch) => {
  const store = makeStore(undefined, true);
  await store.boardAppDisplay(sessionKey, [widget], widget, payload);
  await rawRecords((record) =>
    mismatch === "version"
      ? { ...record, projectionVersion: 99 }
      : { ...record, model: { html: 42 } },
  );
  expect(await store.boardAppDisplay(sessionKey, [widget], widget)).toBeNull();
  expect(await rawRecords()).toEqual([]);
  expect(await store.boardAppDisplay(sessionKey, [widget], widget, payload)).not.toBeNull();
});

it("retires queued display writes when the store disconnects and reconnects", async () => {
  const store = makeStore(undefined, true);
  const writing = store.boardAppDisplay(sessionKey, [widget], widget, payload);
  store.disconnect();
  store.connect();
  await writing;
  expect(await store.boardAppDisplay(sessionKey, [widget], widget)).toBeNull();
  expect(await rawRecords()).toEqual([]);
});
