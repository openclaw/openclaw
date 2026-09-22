import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import { createMentionsCapability } from "./mentions.ts";

beforeEach(stubGatewayStoreTestGlobals);
afterEach(() => vi.unstubAllGlobals());

it("refreshes plugin methods and surfaces on the existing connection", async () => {
  const { gateway, clients, current } = createGatewayStoreTestStore();
  gateway.start();
  current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
  const sessionKey = gateway.snapshot.sessionKey;
  const before = gateway.snapshot;
  const publications = new Map<number, boolean>();
  gateway.subscribe((snapshot) => {
    if (snapshot.pluginCapabilities?.generation !== undefined) {
      publications.set(
        snapshot.pluginCapabilities.generation,
        isGatewayMethodAdvertised(snapshot, "plugin.notes.read") === true,
      );
    }
  });
  const capabilities = {
    ok: true,
    generation: 7,
    descriptors: [],
    methods: ["plugins.reload", "plugin.notes.read"],
    controlUiTabs: [{ pluginId: "notes", id: "notes", label: "Notes" }],
    controlUiWidgetKinds: [{ pluginId: "notes", kind: "notes:card", label: "Note" }],
    pluginSurfaceUrls: {},
  };
  current().request.mockResolvedValue(capabilities);
  current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation: 7 }));
  await vi.waitFor(() => expect(gateway.snapshot.pluginCapabilities?.generation).toBe(7));
  expect(gateway.snapshot.hello).toMatchObject({
    features: { methods: capabilities.methods },
    controlUiTabs: capabilities.controlUiTabs,
    controlUiWidgetKinds: capabilities.controlUiWidgetKinds,
  });
  current().request.mockResolvedValue({
    ...capabilities,
    generation: 8,
    methods: ["plugins.reload"],
    controlUiTabs: [],
    controlUiWidgetKinds: [],
  });
  current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation: 8 }));
  await vi.waitFor(() => expect(gateway.snapshot.hello?.controlUiTabs).toEqual([]));
  expect(gateway.snapshot).not.toBe(before);
  expect(gateway.snapshot.hello).toBe(before.hello);
  expect(gateway.snapshot.hello?.auth).toBe(before.hello?.auth);
  expect([...publications]).toEqual([
    [7, true],
    [8, false],
  ]);
  expect(gateway.snapshot.sessionKey).toBe(sessionKey);
  expect(gateway.snapshot.phase).toBe("connected");
  expect(clients).toHaveLength(1);
  expect(current().stopped).toBe(0);
  gateway.stop();
});

it.each(["replacement", "same-client reconnect"] as const)(
  "discards a capability response after %s",
  async (boundary) => {
    const { gateway, current } = createGatewayStoreTestStore();
    gateway.start();
    current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
    let resolve!: (value: unknown) => void;
    current().request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation: 7 }));
    await vi.waitFor(() =>
      expect(current().request).toHaveBeenCalledWith("plugins.uiDescriptors", {}),
    );
    if (boundary === "replacement") {
      gateway.connect();
    } else {
      current().opts.onClose?.({ code: 1006, reason: "disconnected", willRetry: true });
    }
    current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
    resolve({
      ok: true,
      generation: 7,
      descriptors: [],
      methods: ["plugin.retired.read"],
      controlUiTabs: [],
      controlUiWidgetKinds: [],
      pluginSurfaceUrls: {},
    });
    await vi.dynamicImportSettled();
    expect(gateway.snapshot.pluginCapabilities).toBeNull();
    expect(gateway.snapshot.hello?.features?.methods).toBeUndefined();
    gateway.stop();
  },
);

it("keeps the latest capability refresh through invalid events and older failures", async () => {
  const { gateway, current } = createGatewayStoreTestStore();
  gateway.start();
  current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
  const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  current().request.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  const capabilities = (generation: number) => ({
    ok: true,
    generation,
    descriptors: [],
    methods: ["plugins.reload"],
    controlUiTabs: [],
    controlUiWidgetKinds: [],
    pluginSurfaceUrls: {},
  });
  const changed = (generation: unknown) =>
    current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation }));

  changed(7);
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  changed("invalid");
  await vi.dynamicImportSettled();
  expect(pending).toHaveLength(1);
  pending[0]!.resolve(capabilities(7));
  await vi.waitFor(() => expect(gateway.snapshot.pluginCapabilities?.generation).toBe(7));

  changed(8);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  changed(9);
  await vi.waitFor(() => expect(pending).toHaveLength(3));
  pending[2]!.resolve(capabilities(9));
  await vi.waitFor(() => expect(gateway.snapshot.pluginCapabilities?.generation).toBe(9));
  pending[1]!.reject(new Error("superseded capability request"));
  await vi.dynamicImportSettled();
  expect(gateway.snapshot.pluginCapabilities?.generation).toBe(9);
  expect(gateway.snapshot.lastError).toBeNull();
  gateway.stop();
});

it("preserves an in-flight Inbox read across capability publication", async () => {
  const { gateway, current } = createGatewayStoreTestStore();
  gateway.start();
  const auth = { role: "operator", scopes: ["operator.read"] };
  const server = { bootId: "inbox-boot", connId: "inbox-connection" };
  current().opts.onHello?.({
    ...GATEWAY_STORE_TEST_HELLO,
    auth,
    server,
    features: { methods: ["mentions.list"] },
    snapshot: {
      presence: [
        {
          instanceId: current().instanceId,
          user: { id: "reader", identity: { type: "profile", id: "reader" } },
        },
      ],
    },
  });
  const inboxRead = createDeferred<unknown>();
  current().request.mockImplementation((method) => {
    if (method === "mentions.list") {
      return inboxRead.promise;
    }
    if (method === "plugins.uiDescriptors") {
      return Promise.resolve({
        ok: true,
        generation: 1,
        descriptors: [],
        methods: ["mentions.list", "plugin.notes.read"],
        controlUiTabs: [{ pluginId: "notes", id: "notes", label: "Notes" }],
        controlUiWidgetKinds: [],
        pluginSurfaceUrls: {},
      });
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const inbox = createMentionsCapability(gateway);
  try {
    await vi.waitFor(() => expect(current().request).toHaveBeenCalledWith("mentions.list", {}));
    current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation: 1 }));
    await vi.waitFor(() => expect(gateway.snapshot.pluginCapabilities?.generation).toBe(1));
    expect(gateway.snapshot.hello?.auth).toBe(auth);
    expect(gateway.snapshot.hello?.server).toBe(server);
    const item = {
      id: "mention-1",
      senderProfileId: "writer",
      senderLabel: "Writer",
      sessionKey: "agent:main:review",
      agentId: "main",
      sessionTitle: "Review",
      messageId: "message-1",
      createdAt: 1000,
      expiresAt: 10000,
      excerpt: "Please review this",
    };
    inboxRead.resolve({ gatewayInstanceId: server.bootId, revision: 1, items: [item] });
    await vi.waitFor(() => expect(inbox.snapshot).toMatchObject({ phase: "ready", items: [item] }));
    expect(
      current().request.mock.calls.filter(([method]) => method === "mentions.list"),
    ).toHaveLength(1);
  } finally {
    inbox.dispose();
    gateway.stop();
  }
});
