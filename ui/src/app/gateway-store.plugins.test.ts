import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginsUiDescriptorsResult } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { clearBootRecords, persistBootRecord, type BootRecord } from "./boot-record.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import type { ApplicationGatewayConnectOptions } from "./gateway.ts";
import { createMentionsCapability } from "./mentions.ts";
import { loadSettings } from "./settings.ts";

function capabilities(
  generation: number,
  overrides: Partial<Required<PluginsUiDescriptorsResult>> = {},
) {
  return {
    ok: true,
    generation,
    descriptors: [],
    methods: ["plugins.reload"],
    controlUiTabs: [],
    controlUiWidgetKinds: [],
    pluginSurfaceUrls: {},
    ...overrides,
  };
}

describe("plugin capabilities", () => {
  let gateway: ReturnType<typeof createGatewayStoreTestStore>["gateway"];
  let current: ReturnType<typeof createGatewayStoreTestStore>["current"];
  let clients: ReturnType<typeof createGatewayStoreTestStore>["clients"];
  beforeEach(() => {
    stubGatewayStoreTestGlobals();
    ({ gateway, current, clients } = createGatewayStoreTestStore());
    gateway.start();
  });
  afterEach(() => {
    gateway.stop();
    vi.unstubAllGlobals();
  });

  it("refreshes plugin methods and surfaces on the existing connection", async () => {
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
    const published = capabilities(7, {
      methods: ["plugins.reload", "plugin.notes.read"],
      controlUiTabs: [{ pluginId: "notes", id: "notes", label: "Notes" }],
      controlUiWidgetKinds: [{ pluginId: "notes", kind: "notes:card", label: "Note" }],
    });
    current().request.mockResolvedValue(published);
    current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation: 7 }));
    await vi.waitFor(() => expect(gateway.snapshot.pluginCapabilities?.generation).toBe(7));
    expect(gateway.snapshot.hello).toMatchObject({
      features: { methods: published.methods },
      controlUiTabs: published.controlUiTabs,
      controlUiWidgetKinds: published.controlUiWidgetKinds,
    });
    current().request.mockResolvedValue(capabilities(8));
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
  });

  it.each([
    { boundary: "replacement", event: "plugins.changed" },
    { boundary: "same-client reconnect", event: "plugins.controlUi.changed" },
  ])("discards a $event capability response after $boundary", async ({ boundary, event }) => {
    current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
    const pending = createDeferred<unknown>();
    current().request.mockReturnValue(pending.promise);
    current().opts.onEvent?.(
      createGatewayEvent(
        event,
        event === "plugins.changed" ? { generation: 7 } : { revision: "off" },
      ),
    );
    await vi.waitFor(() =>
      expect(current().request).toHaveBeenCalledWith("plugins.uiDescriptors", {}),
    );
    if (boundary === "replacement") {
      gateway.connect();
    } else {
      current().opts.onClose?.({ code: 1006, reason: "disconnected", willRetry: true });
    }
    current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
    pending.resolve(capabilities(7, { methods: ["plugin.retired.read"] }));
    await vi.dynamicImportSettled();
    expect(gateway.snapshot.pluginCapabilities).toBeNull();
    expect(gateway.snapshot.hello?.features?.methods).toBeUndefined();
  });

  it("ignores malformed plugin change events", async () => {
    current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
    const pending: ReturnType<typeof createDeferred<unknown>>[] = [];
    current().request.mockImplementation(() => {
      const request = createDeferred<unknown>();
      pending.push(request);
      return request.promise;
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

    current().opts.onEvent?.(createGatewayEvent("plugins.controlUi.changed", { revision: "off" }));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    current().opts.onEvent?.(createGatewayEvent("plugins.controlUi.changed", { revision: 42 }));
    await vi.dynamicImportSettled();
    expect(pending).toHaveLength(2);
    pending[1]!.resolve(capabilities(8));
    await vi.waitFor(() => expect(gateway.snapshot.pluginCapabilities?.generation).toBe(8));
  });

  it("preserves an in-flight Inbox read across capability publication", async () => {
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
            ts: 0,
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
        return Promise.resolve(
          capabilities(1, {
            methods: ["mentions.list", "plugin.notes.read"],
            controlUiTabs: [{ pluginId: "notes", id: "notes", label: "Notes" }],
          }),
        );
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
      await vi.waitFor(() =>
        expect(inbox.snapshot).toMatchObject({ phase: "ready", items: [item] }),
      );
      expect(
        current().request.mock.calls.filter(([method]) => method === "mentions.list"),
      ).toHaveLength(1);
    } finally {
      inbox.dispose();
    }
  });
});

describe("warm admission ownership", () => {
  function bootRecord(scope: string, overrides: Partial<BootRecord> = {}): BootRecord {
    return {
      version: 2,
      authMethod: "token",
      credential: "9d17676d",
      recoveryScope: "account-a",
      scope,
      savedAt: Date.now(),
      profileId: "profile-a",
      agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
      groups: [],
      sectionOrder: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
  });

  afterEach(async () => {
    clearBootRecords();
    await vi.dynamicImportSettled();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("supplies cached identity without authorizing recovery", () => {
    const settings = { ...loadSettings(), token: "" };
    const record = bootRecord(gatewayCredentialScope(settings.gatewayUrl), {
      authMethod: "trusted-proxy",
      credential: "",
    });
    persistBootRecord(record);
    window.dispatchEvent(new Event("pagehide"));
    const { gateway, current } = createGatewayStoreTestStore({ settings });
    gateway.connect();
    expect(current().opts.offlineRecoveryScope).toBe("account-a");
    expect(current().opts.password).toBeUndefined();
    expect(current().opts.token).toBeUndefined();
    expect(gateway.snapshot.phase).toBe("connecting");
    gateway.stop();
  });

  it.each([
    {
      name: "fresh bootstrap",
      overrides: { bootstrapToken: "synthetic-bootstrap" },
      admitted: false,
    },
    { name: "same owner", overrides: {}, admitted: true, replacementScope: "account-a" },
    { name: "replacement owner", overrides: {}, admitted: true, replacementScope: "account-b" },
  ] satisfies Array<{
    name: string;
    overrides: ApplicationGatewayConnectOptions;
    admitted: boolean;
    replacementScope?: string;
  }>)(
    "retires only captured admission on rejected $name",
    ({ overrides, admitted, replacementScope }) => {
      const settings = { ...loadSettings(), token: "test-token" };
      const { gateway, current } = createGatewayStoreTestStore({ settings });
      const scope = gatewayCredentialScope(settings.gatewayUrl);
      const saved = bootRecord(scope);
      persistBootRecord(saved);
      window.dispatchEvent(new Event("pagehide"));
      const key = "openclaw.control.bootRecord.v1:" + scope;
      const bytes = localStorage.getItem(key);
      try {
        gateway.connect(overrides);
        expect(current().opts.offlineRecoveryScope).toBe(admitted ? "account-a" : undefined);
        const replacement = { ...saved, recoveryScope: replacementScope };
        if (admitted) {
          persistBootRecord(replacement);
          window.dispatchEvent(new Event("pagehide"));
          persistBootRecord(replacement);
        }
        current().opts.onClose?.({
          code: 4008,
          reason: "rejected",
          willRetry: false,
          error: { code: "PAIRING_REQUIRED", message: "Rejected synthetic admission" },
        });
        if (!admitted) {
          expect(localStorage.getItem(key)).toBe(bytes);
        }
        window.dispatchEvent(new Event("pagehide"));
        expect(localStorage.getItem(key)).toBe(
          !admitted ? bytes : replacementScope === "account-a" ? null : JSON.stringify(replacement),
        );
        expect(gateway.snapshot.phase).toBe("stopped");
      } finally {
        gateway.stop();
      }
    },
  );

  it.each(["rejection", "credential edit"])(
    "retires captured legacy and live owners after hello on %s",
    (transition) => {
      const settings = { ...loadSettings(), token: "test-token" };
      const scope = gatewayCredentialScope(settings.gatewayUrl);
      const key = "openclaw.control.bootRecord.v1:" + scope;
      const legacy = bootRecord(scope, { recoveryScope: undefined });
      for (const published of ["legacy", "live", "peer"] as const) {
        localStorage.setItem(key, JSON.stringify(legacy));
        const { gateway, current } = createGatewayStoreTestStore({ settings });
        try {
          gateway.connect();
          current().opts.onHello?.({
            type: "hello-ok",
            protocol: 1,
            auth: { method: "token", role: "operator", scopes: [], recoveryScope: "live-owner" },
            snapshot: { authMode: "token" },
          });
          const replacement =
            published === "legacy"
              ? legacy
              : { ...legacy, recoveryScope: published === "live" ? "live-owner" : "peer-owner" };
          localStorage.setItem(key, JSON.stringify(replacement));
          persistBootRecord(replacement);
          if (transition === "rejection") {
            current().opts.onClose?.({
              code: 4008,
              reason: "rejected",
              willRetry: false,
              error: { code: "PAIRING_REQUIRED", message: "Rejected admitted owner" },
            });
          } else {
            gateway.connect({ token: "replacement-token" });
          }
          window.dispatchEvent(new Event("pagehide"));
          expect(localStorage.getItem(key), published).toBe(
            published === "peer" ? JSON.stringify(replacement) : null,
          );
        } finally {
          gateway.stop();
        }
      }
    },
  );
});
