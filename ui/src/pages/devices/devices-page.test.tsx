/* @vitest-environment jsdom */

import type { EnvironmentSummary, SystemInfoResult } from "@openclaw/gateway-protocol";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { PresenceEntry } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context-types.ts";
import { t } from "../../i18n/index.ts";
import {
  createInitialDevicesState,
  type DevicesPageDataState,
} from "../../lib/nodes/page-operations.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import {
  deviceSystemInfo,
  deviceDesktopEnvironments,
} from "../../test-helpers/devices-fixtures.ts";
import {
  createModalDialogTestFixture,
  waitForRenderedModalDialog,
} from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { DevicesPage, type DevicesRouteData } from "./devices-page.tsx";

const ROTATED_TOKEN = "rotated-operator-token";
const gatewayPresence: PresenceEntry = { mode: "gateway", host: "Gateway host", ts: 1_000 };
const pairedDevice = {
  deviceId: "device-1",
  displayName: "MacBook Pro",
  tokens: [{ role: "operator", scopes: [] }],
};
let dialogs: ReturnType<typeof createModalDialogTestFixture>;
const cleanups: Array<() => void> = [];

function stubLocalDeviceIdentity() {
  localStorage.setItem(
    "openclaw-device-identity-v1",
    JSON.stringify({
      version: 1,
      deviceId: "00",
      publicKey: "AA",
      privateKey: "AA",
    }),
  );
  vi.stubGlobal("crypto", { subtle: { digest: async () => new Uint8Array([0]).buffer } });
}

function gatewaySnapshot(
  client: GatewayBrowserClient | null,
  connected = true,
  methods: string[] = [],
  scopes = ["operator.read", "operator.pairing"],
): ApplicationGatewaySnapshot {
  return {
    client,
    phase: connected ? "connected" : "reconnecting",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes },
      features: { methods },
      snapshot: { presence: [gatewayPresence] },
    },
  } as ApplicationGatewaySnapshot;
}

function gatewayFixture(initial: ApplicationGatewaySnapshot) {
  let snapshot = initial;
  const listeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<(event: { event: string; payload?: unknown }) => void>();
  const source = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "http://gateway.test" },
    subscribe: vi.fn((listener: (value: ApplicationGatewaySnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    subscribeEvents: vi.fn((listener: (event: { event: string; payload?: unknown }) => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    }),
  } as unknown as ApplicationContext["gateway"];
  return {
    source,
    emitSnapshot(next: ApplicationGatewaySnapshot) {
      snapshot = next;
      for (const listener of listeners) {
        listener(next);
      }
      flush();
    },
    emitEvent(event: string, payload?: unknown) {
      for (const listener of eventListeners) {
        listener({ event, payload });
      }
      flush();
    },
    get subscriptions() {
      return listeners.size + eventListeners.size;
    },
  };
}

function mountPage(
  fixture: ReturnType<typeof gatewayFixture>,
  initial: Partial<DevicesPageDataState> = {},
  routeOverride?: Partial<DevicesRouteData>,
) {
  const snapshot = fixture.source.snapshot;
  const routeData: DevicesRouteData = {
    gateway: fixture.source,
    gatewaySnapshot: snapshot,
    devices: {
      ...createInitialDevicesState({
        client: snapshot.client,
        connected: snapshot.phase === "connected",
      }),
      ...initial,
    },
    ...routeOverride,
  };
  const [currentGateway, setGateway] = createSignal(fixture.source);
  const context = {
    get gateway() {
      return currentGateway();
    },
    basePath: "",
    runtimeConfig: {
      state: { configSnapshot: {}, configForm: {}, configLoading: false, configFormMode: "form" },
      subscribe: () => () => undefined,
    },
  } as unknown as ApplicationContext;
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = mountSolid(
    () => (
      <ApplicationProvider value={context}>
        <DevicesPage routeData={routeData} />
      </ApplicationProvider>
    ),
    { container },
  );
  flush();
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    mounted.unmount();
    container.remove();
    flush();
  };
  cleanups.push(dispose);
  return {
    container,
    dispose,
    replaceGateway(next: ReturnType<typeof gatewayFixture>) {
      setGateway(next.source);
      flush();
    },
  };
}

function responseFor(method: string): unknown {
  if (method === "system-presence") {
    return [gatewayPresence];
  }
  if (method === "system.info") {
    return deviceSystemInfo;
  }
  if (method === "environments.list") {
    return { environments: deviceDesktopEnvironments };
  }
  if (method === "exec.approvals.get") {
    return {
      path: "/synthetic/exec-approvals.json",
      exists: true,
      hash: "initial",
      file: { version: 1 },
    };
  }
  return { nodes: [], paired: [], pending: [] };
}

function clientFor(request = vi.fn(async (method: string) => responseFor(method))) {
  return { client: { request } as unknown as GatewayBrowserClient, request };
}

function button(container: ParentNode, label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) {
    throw new Error(`Expected ${label} button`);
  }
  return found;
}

function dialogButton(label: string) {
  const modal = document.body.querySelector("openclaw-modal-dialog");
  if (!modal) {
    throw new Error("Expected an open dialog");
  }
  return button(modal, label);
}

function selectEntryAction(container: ParentNode, action: string, name = "MacBook Pro") {
  const row = [...container.querySelectorAll(".device-entry")].find(
    (entry) => entry.querySelector(".settings-row__title")?.textContent === name,
  );
  const menu = row?.querySelector("wa-dropdown");
  if (!menu) {
    throw new Error("Expected device actions menu");
  }
  menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: action } } }));
  flush();
}

function secretDialogText() {
  return document.body.querySelector(".secret-reveal__code")?.textContent?.trim() ?? "";
}

async function expectNoModal() {
  await vi.waitFor(() => expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull());
}

function mountPaired(request: Parameters<typeof clientFor>[0]) {
  const { client } = clientFor(request);
  const fixture = gatewayFixture(gatewaySnapshot(client));
  const page = mountPage(fixture, {
    devicesList: { paired: [pairedDevice], pending: [] },
    nodes: [{ nodeId: "node-1", displayName: "Office Mac" }],
  });
  return { ...page, fixture, client };
}

function rotatingRequest(token: string | null) {
  return dialogs.mockRequest(async (method: string, params?: unknown) => {
    if (method !== "device.token.rotate") {
      return responseFor(method);
    }
    const { deviceId, role } = params as { deviceId: string; role: string };
    return {
      deviceId,
      role,
      scopes: [],
      rotatedAtMs: 1_700_000_000_000,
      ...(token ? { token } : {}),
      tokenDelivery: token ? "in-band" : "withheld-cross-device",
    };
  });
}

describe("DevicesPage gateway lifecycle", () => {
  beforeEach(() => {
    dialogs = createModalDialogTestFixture((modal) => {
      const acknowledge = modal.querySelector<HTMLButtonElement>(
        ".exec-approval-actions button[autofocus]",
      );
      if (acknowledge) {
        acknowledge.click();
      } else {
        modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
      }
    });
  });
  afterEach(async () => {
    try {
      for (const dispose of cleanups.splice(0)) {
        dispose();
      }
      await dialogs.cleanup();
    } finally {
      localStorage.clear();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("preserves matching route data, then clears inventory on provider replacement", async () => {
    const fixture = gatewayFixture(gatewaySnapshot(null, false));
    const page = mountPage(fixture, {
      nodes: [{ nodeId: "preloaded", displayName: "Preloaded Mac" }],
    });
    expect(page.container.textContent).toContain("Preloaded Mac");
    fixture.emitEvent("presence", {
      presence: [{ host: "Stale presence", instanceId: "stale", ts: 1_000 }],
    });
    expect(page.container.textContent).toContain("Stale presence");
    page.replaceGateway(gatewayFixture(gatewaySnapshot(null, false)));
    expect(page.container.textContent).not.toContain("Preloaded Mac");
    expect(page.container.textContent).not.toContain("Stale presence");
  });

  it("rejects preloaded data after a same-client gateway epoch change", async () => {
    const { client, request } = clientFor();
    const fixture = gatewayFixture(gatewaySnapshot(client));
    const page = mountPage(
      fixture,
      { nodes: [{ nodeId: "stale", displayName: "Stale Mac" }] },
      {
        gatewaySnapshot: gatewaySnapshot(client, false),
      },
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("node.list", {}));
    expect(page.container.textContent).not.toContain("Stale Mac");
  });

  it.each(["node.runnerInventory.changed", "node.hostStats"])(
    "quietly reloads node status for %s",
    async (event) => {
      const nodes = createDeferred<{ nodes: Array<Record<string, unknown>> }>();
      const { client, request } = clientFor(
        vi.fn(async (method: string) =>
          method === "node.list" ? nodes.promise : responseFor(method),
        ),
      );
      const fixture = gatewayFixture(gatewaySnapshot(client));
      const page = mountPage(fixture, {
        nodes: [{ nodeId: "node-1", displayName: "Office Mac", connected: false }],
        devicesList: { paired: [], pending: [] },
        lastError: "Earlier operator action failed",
      });
      fixture.emitEvent(event, { nodeId: "node-1" });
      expect(request).toHaveBeenCalledWith("node.list", {});
      expect(page.container.textContent).toContain("Office Mac");
      expect(page.container.textContent).toContain("Earlier operator action failed");
      nodes.resolve({ nodes: [{ nodeId: "node-1", displayName: "Current Mac", connected: true }] });
      await vi.waitFor(() => expect(page.container.textContent).toContain("Current Mac"));
    },
  );

  it.each([
    {
      name: "advertised",
      methods: ["system.info", "desktop.observe"],
      systemInfo: true,
      desktop: true,
      scopes: ["operator.admin"],
    },
    { name: "unadvertised", methods: [], systemInfo: false, desktop: false },
    { name: "unknown features", methods: undefined, systemInfo: false, desktop: false },
    {
      name: "read-only",
      methods: ["system.info", "desktop.observe"],
      systemInfo: true,
      desktop: false,
      scopes: ["operator.read"],
    },
    {
      name: "session-only",
      methods: ["system.info", "desktop.observe"],
      systemInfo: false,
      desktop: false,
      scopes: ["operator.sessions.read", "operator.sessions.write"],
    },
  ])("loads only available host details for $name connections", async (scenario) => {
    const { client, request } = clientFor();
    const snapshot = gatewaySnapshot(client, true, scenario.methods, scenario.scopes);
    if (scenario.methods === undefined && snapshot.hello) {
      delete snapshot.hello.features;
    }
    const page = mountPage(gatewayFixture(snapshot), { devicesList: { paired: [], pending: [] } });
    await vi.waitFor(() => expect(page.container.textContent).toContain("Gateway host"));
    await Promise.resolve();
    flush();
    expect(request.mock.calls.some(([method]) => method === "system.info")).toBe(
      scenario.systemInfo,
    );
    expect(request.mock.calls.some(([method]) => method === "environments.list")).toBe(
      scenario.desktop,
    );
    await vi.waitFor(() => {
      expect(page.container.querySelector(".device-entry__desktop") !== null).toBe(
        scenario.desktop,
      );
      expect(page.container.querySelector(".device-resource--load") !== null).toBe(
        scenario.systemInfo,
      );
    });
  });

  it("refreshes host details with quiet inventory polling and stops after disposal", async () => {
    vi.useFakeTimers();
    const { client, request } = clientFor();
    const fixture = gatewayFixture(
      gatewaySnapshot(client, true, ["system.info", "desktop.observe"], ["operator.admin"]),
    );
    const page = mountPage(fixture);
    await vi.advanceTimersByTimeAsync(0);
    flush();
    request.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    flush();
    expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(2);
    page.dispose();
    request.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    fixture.emitEvent("node.hostStats", {});
    expect(request).not.toHaveBeenCalled();
    expect(fixture.subscriptions).toBe(0);
  });

  it("stops denied system-info refreshes until the connection resets", async () => {
    vi.useFakeTimers();
    const { client, request } = clientFor(
      vi.fn(async (method: string) => {
        if (method === "system.info") {
          throw new GatewayRequestError({
            code: "FORBIDDEN",
            message: "permission denied",
            details: {
              code: "MISSING_SCOPE",
              missingScope: "operator.read",
              requiredScopes: ["operator.read"],
            },
          });
        }
        return responseFor(method);
      }),
    );
    const snapshot = gatewaySnapshot(client, true, ["system.info"]);
    const fixture = gatewayFixture(snapshot);
    mountPage(fixture);
    await vi.advanceTimersByTimeAsync(120_000);
    flush();
    expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(1);
    fixture.emitSnapshot({ ...snapshot, phase: "reconnecting" });
    fixture.emitSnapshot(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(2);
  });

  it.each(["reconnect", "provider replacement", "dispose"])(
    "retires host-detail responses after %s",
    async (transition) => {
      const systemInfo = createDeferred<SystemInfoResult>();
      const environments = createDeferred<{ environments: EnvironmentSummary[] }>();
      const { client, request } = clientFor(
        vi.fn(async (method: string) => {
          if (method === "system.info") {
            return systemInfo.promise;
          }
          if (method === "environments.list") {
            return environments.promise;
          }
          return responseFor(method);
        }),
      );
      const snapshot = gatewaySnapshot(
        client,
        true,
        ["system.info", "desktop.observe"],
        ["operator.admin"],
      );
      const fixture = gatewayFixture(snapshot);
      const page = mountPage(fixture);
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("environments.list", {}, expect.anything()),
      );
      if (transition === "dispose") {
        page.dispose();
      } else {
        request.mockImplementation(async (method: string) =>
          method === "environments.list"
            ? { environments: [] }
            : method === "system.info"
              ? { ...deviceSystemInfo, loadAverage: [8, 4, 2] }
              : responseFor(method),
        );
        if (transition === "reconnect") {
          fixture.emitSnapshot({ ...snapshot, phase: "reconnecting" });
          fixture.emitSnapshot(snapshot);
        } else {
          page.replaceGateway(gatewayFixture(snapshot));
        }
        await vi.waitFor(() =>
          expect(page.container.querySelector(".device-resource--load")?.textContent).toContain(
            "8.0",
          ),
        );
      }
      systemInfo.resolve(deviceSystemInfo);
      environments.resolve({ environments: deviceDesktopEnvironments });
      await Promise.all([systemInfo.promise, environments.promise]);
      await vi.waitFor(() => {
        expect(page.container.querySelector(".device-entry__desktop")).toBeNull();
        if (transition !== "dispose") {
          expect(page.container.querySelector(".device-resource--load")?.textContent).toContain(
            "8.0",
          );
        }
      });
    },
  );

  it.each(["device", "node"])(
    "coalesces a %s refresh while an older list is loading",
    async (kind) => {
      const stale = createDeferred<unknown>();
      const refreshed = createDeferred<unknown>();
      const methodName = kind === "device" ? "device.pair.list" : "node.list";
      let listCalls = 0;
      const { client, request } = clientFor(
        vi.fn(async (method: string) =>
          method === methodName
            ? ++listCalls === 1
              ? stale.promise
              : refreshed.promise
            : responseFor(method),
        ),
      );
      const fixture = gatewayFixture(gatewaySnapshot(client));
      const page = mountPage(fixture);
      await vi.waitFor(() => expect(listCalls).toBe(1));
      fixture.emitEvent(kind === "device" ? "device.pair.changed" : "node.hostStats", {});
      stale.resolve(
        kind === "device"
          ? { paired: [{ deviceId: "device-1", displayName: "Kitchen Mac" }], pending: [] }
          : { nodes: [{ nodeId: "node-1", displayName: "Kitchen Mac" }] },
      );
      await vi.waitFor(() => expect(listCalls).toBe(2));
      refreshed.resolve(
        kind === "device"
          ? {
              paired: [
                { deviceId: "device-1", displayName: "Kitchen Mac", operatorLabel: "Studio Mac" },
              ],
              pending: [],
            }
          : { nodes: [{ nodeId: "node-1", displayName: "Studio Mac" }] },
      );
      await vi.waitFor(() => expect(page.container.textContent).toContain("Studio Mac"));
      expect(request.mock.calls.filter(([method]) => method === methodName)).toHaveLength(2);
    },
  );

  it("keeps initial and event-driven pairing and exec-approval loads gated by scopes", async () => {
    const { client, request } = clientFor();
    const fixture = gatewayFixture(
      gatewaySnapshot(
        client,
        true,
        ["node.list", "device.pair.list", "exec.approvals.get"],
        ["operator.read"],
      ),
    );
    const page = mountPage(fixture);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("node.list", {}));
    fixture.emitEvent("presence", {
      presence: [{ instanceId: "browser-1", ts: 2_000, reason: "connect" }],
    });
    fixture.emitEvent("device.pair.changed", {});
    await Promise.resolve();
    flush();
    expect(request.mock.calls.map(([method]) => method)).not.toContain("device.pair.list");
    expect(request.mock.calls.map(([method]) => method)).not.toContain("exec.approvals.get");
    expect(button(page.container, t("devices.pairing.button")).disabled).toBe(true);
  });

  it.each([
    { name: "node disconnects", role: "node", nodeRoles: ["node"], operatorRoles: ["operator"] },
    {
      name: "merged node-role presence disconnects",
      role: "node",
      nodeRoles: ["operator", "node"],
      operatorRoles: ["operator"],
    },
    {
      name: "operator disconnects",
      role: "operator",
      nodeRoles: ["node"],
      operatorRoles: ["operator"],
    },
    {
      name: "node disconnects with a roleless operator",
      role: "node",
      nodeRoles: ["node"],
      operatorRoles: undefined,
    },
  ])("reloads mixed-role inventory when $name", async (scenario) => {
    const { client, request } = clientFor();
    const fixture = gatewayFixture(gatewaySnapshot(client));
    mountPage(fixture, { nodes: [{ nodeId: "node-1" }], devicesList: { paired: [], pending: [] } });
    const node: PresenceEntry = {
      deviceId: "mixed-role-device",
      instanceId: "node",
      roles: scenario.nodeRoles,
      reason: "connect",
      ts: 2_000,
    };
    const operator: PresenceEntry = {
      deviceId: "mixed-role-device",
      instanceId: "operator-session",
      roles: scenario.operatorRoles,
      reason: "connect",
      ts: 1_000,
    };
    fixture.emitEvent("presence", { presence: [node, operator] });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("device.pair.list", {}));
    await Promise.resolve();
    flush();
    request.mockClear();
    fixture.emitEvent("presence", {
      presence: [
        scenario.role === "node" ? { ...node, reason: "disconnect" } : node,
        scenario.role === "operator" ? { ...operator, reason: "disconnect" } : operator,
      ],
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("node.list", {}));
    expect(request).toHaveBeenCalledWith("device.pair.list", {});
  });

  it("does not reload mixed-role inventory for presence activity updates", async () => {
    const { client, request } = clientFor();
    const fixture = gatewayFixture(gatewaySnapshot(client));
    mountPage(fixture, { nodes: [{ nodeId: "node-1" }], devicesList: { paired: [], pending: [] } });
    const presence: PresenceEntry[] = [
      { deviceId: "mixed-role-device", roles: ["node"], reason: "connect", ts: 2_000 },
      { deviceId: "mixed-role-device", roles: ["operator"], reason: "connect", ts: 1_000 },
    ];
    fixture.emitEvent("presence", { presence });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("device.pair.list", {}));
    await Promise.resolve();
    flush();
    request.mockClear();
    fixture.emitEvent("presence", {
      presence: presence.map((entry) =>
        Object.assign({}, entry, { lastInputSeconds: 3, ts: entry.ts + 100 }),
      ),
    });
    await Promise.resolve();
    flush();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["reconnect", "provider replacement", "remount"])(
    "retires an in-flight node load across %s",
    async (transition) => {
      const first = createDeferred<unknown>();
      const second = createDeferred<unknown>();
      let listCalls = 0;
      const { client } = clientFor(
        vi.fn(async (method: string) =>
          method === "node.list"
            ? ++listCalls === 1
              ? first.promise
              : second.promise
            : responseFor(method),
        ),
      );
      const snapshot = gatewaySnapshot(client);
      const fixture = gatewayFixture(snapshot);
      let page = mountPage(fixture);
      await vi.waitFor(() => expect(listCalls).toBe(1));
      if (transition === "reconnect") {
        fixture.emitSnapshot({ ...snapshot, phase: "reconnecting" });
        fixture.emitSnapshot(snapshot);
      } else if (transition === "provider replacement") {
        page.replaceGateway(gatewayFixture(snapshot));
      } else {
        page.dispose();
        page = mountPage(fixture);
      }
      await vi.waitFor(() => expect(listCalls).toBe(2));
      first.resolve({ nodes: [{ nodeId: "old", displayName: "Old Mac" }] });
      await first.promise;
      await Promise.resolve();
      flush();
      expect(page.container.textContent).not.toContain("Old Mac");
      second.resolve({ nodes: [{ nodeId: "new", displayName: "New Mac" }] });
      await vi.waitFor(() => expect(page.container.textContent).toContain("New Mac"));
    },
  );

  it.each(["removal", "alias"])(
    "cancels a pending %s dialog when the connection resets",
    async (kind) => {
      const request = vi.fn(async (method: string) => responseFor(method));
      const page = mountPaired(request);
      selectEntryAction(page.container, kind === "alias" ? "editAlias" : "remove");
      await waitForRenderedModalDialog(document.body);
      request.mockClear();
      page.fixture.emitSnapshot(gatewaySnapshot(page.client, false));
      await expectNoModal();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rejects a device pairing request after the in-app dialog is confirmed", async () => {
    const { client, request } = clientFor();
    const fixture = gatewayFixture(gatewaySnapshot(client));
    const page = mountPage(fixture, {
      nodes: [{ nodeId: "node-1" }],
      devicesList: {
        paired: [],
        pending: [{ requestId: "request-1", deviceId: "device-1", displayName: "Browser" }],
      },
    });
    button(page.container, t("devices.inventory.reject")).click();
    const { dialog } = await waitForRenderedModalDialog(document.body);
    expect(dialog.getAttribute("aria-label")).toBe(t("devices.inventory.rejectDevicePromptTitle"));
    dialogButton(t("devices.inventory.reject")).click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("device.pair.reject", { requestId: "request-1" }),
    );
    await expectNoModal();
  });

  it("issues no node pairing request when the dialog is cancelled", async () => {
    const { client, request } = clientFor();
    const page = mountPage(gatewayFixture(gatewaySnapshot(client)), {
      nodes: [
        {
          nodeId: "node-1",
          displayName: "Pending node",
          approvalState: "pending-approval",
          pendingRequestId: "request-2",
        },
      ],
      devicesList: { paired: [], pending: [] },
    });
    selectEntryAction(page.container, "reject", "Pending node");
    await waitForRenderedModalDialog(document.body);
    request.mockClear();
    dialogButton(t("common.cancel")).click();
    await expectNoModal();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["connection resets", "pairing access is lost"])(
    "drops a token revoke after %s during confirmation",
    async (transition) => {
      const request = vi.fn(async (method: string) => responseFor(method));
      const page = mountPaired(request);
      button(page.container, t("devices.inventory.revoke")).click();
      const { dialog } = await waitForRenderedModalDialog(document.body);
      expect(dialog.getAttribute("aria-label")).toBe(
        t("devices.inventory.revokePromptTitle", { role: "operator" }),
      );
      request.mockClear();
      if (transition === "connection resets") {
        page.fixture.emitSnapshot(gatewaySnapshot(page.client, false));
      } else {
        page.fixture.emitSnapshot(
          gatewaySnapshot(page.client, true, ["device.token.revoke"], ["operator.read"]),
        );
        dialogButton(t("devices.inventory.revoke")).click();
      }
      await expectNoModal();
      expect(request.mock.calls.map(([method]) => method)).not.toContain("device.token.revoke");
    },
  );

  it("reveals a rotated token with a copy control until it is acknowledged", async () => {
    stubLocalDeviceIdentity();
    const page = mountPaired(rotatingRequest(ROTATED_TOKEN));
    button(page.container, t("devices.inventory.rotate")).click();
    const { dialog } = await waitForRenderedModalDialog(document.body);
    expect(dialog.getAttribute("aria-label")).toBe(
      t("devices.inventory.rotatePromptTitle", { role: "operator" }),
    );
    expect(secretDialogText()).toBe(ROTATED_TOKEN);
    expect(document.body.querySelector(".chat-copy-btn")).toBeInstanceOf(HTMLButtonElement);
    dialogButton(t("devices.inventory.rotateAcknowledge")).click();
    await expectNoModal();
  });

  it("refuses dismissal gestures while the rotated token is still on screen", async () => {
    stubLocalDeviceIdentity();
    const page = mountPaired(rotatingRequest(ROTATED_TOKEN));
    button(page.container, t("devices.inventory.rotate")).click();
    const { modal } = await waitForRenderedModalDialog(document.body);
    const dismissal = new Event("modal-cancel", {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    modal.dispatchEvent(dismissal);
    await modal.updateComplete;
    expect(dismissal.defaultPrevented).toBe(true);
    expect(secretDialogText()).toBe(ROTATED_TOKEN);
    expect(document.body.textContent).toContain(t("devices.inventory.rotateDismissHint"));
    dialogButton(t("devices.inventory.rotateAcknowledge")).click();
    await expectNoModal();
  });

  it("reveals a rotated token that lands after a connection reset", async () => {
    stubLocalDeviceIdentity();
    const rotated = createDeferred<unknown>();
    const request = dialogs.mockRequest(async (method: string) =>
      method === "device.token.rotate" ? rotated.promise : responseFor(method),
    );
    const page = mountPaired(request);
    const outcome = {
      deviceId: "device-1",
      role: "operator",
      scopes: [],
      rotatedAtMs: 1_700_000_000_000,
      token: ROTATED_TOKEN,
      tokenDelivery: "in-band",
    };
    try {
      button(page.container, t("devices.inventory.rotate")).click();
      await vi.waitFor(() =>
        expect(request.mock.calls.map(([method]) => method)).toContain("device.token.rotate"),
      );
      page.fixture.emitSnapshot(gatewaySnapshot(page.client, false));
      rotated.resolve(outcome);
      await waitForRenderedModalDialog(document.body);
      expect(secretDialogText()).toBe(ROTATED_TOKEN);
      dialogButton(t("devices.inventory.rotateAcknowledge")).click();
      await expectNoModal();
    } finally {
      rotated.resolve(outcome);
    }
  });

  it("explains a cross-device rotation the Gateway withheld the token for", async () => {
    stubLocalDeviceIdentity();
    const page = mountPaired(rotatingRequest(null));
    button(page.container, t("devices.inventory.rotate")).click();
    const { dialog } = await waitForRenderedModalDialog(document.body);
    expect(dialog.getAttribute("aria-label")).toBe(
      t("devices.inventory.rotateWithheldTitle", { device: "MacBook Pro" }),
    );
    expect(document.body.textContent).toContain(t("devices.inventory.rotateWithheldNext"));
    expect(document.body.querySelector(".secret-reveal__callout")?.textContent).toContain(
      t("devices.inventory.rotateWithheldException"),
    );
    expect(document.body.querySelector(".secret-reveal__status")).not.toBeNull();
    expect(document.body.querySelector(".secret-reveal__note")?.textContent).toContain(
      t("devices.inventory.rotateWithheldNote"),
    );
    expect(document.body.querySelector(".secret-reveal__code")).toBeNull();
    expect(document.body.querySelector(".chat-copy-btn")).toBeNull();
    expect(dialogButton(t("common.close")).className).toBe("btn secret-reveal__dismiss");
    dialogButton(t("common.close")).click();
    await expectNoModal();
  });

  it("lets a dismissal gesture close the withheld-rotation outcome", async () => {
    stubLocalDeviceIdentity();
    const page = mountPaired(rotatingRequest(null));
    button(page.container, t("devices.inventory.rotate")).click();
    const { modal } = await waitForRenderedModalDialog(document.body);
    const dismissal = new Event("modal-cancel", {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    modal.dispatchEvent(dismissal);
    await expectNoModal();
    expect(dismissal.defaultPrevented).toBe(false);
  });

  it("shows a visible error without a reveal when the rotate request fails", async () => {
    stubLocalDeviceIdentity();
    const request = vi.fn(async (method: string) => {
      if (method === "device.token.rotate") {
        throw new Error("rotate refused");
      }
      return responseFor(method);
    });
    const page = mountPaired(request);
    button(page.container, t("devices.inventory.rotate")).click();
    await vi.waitFor(() => expect(page.container.textContent).toContain("rotate refused"));
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });
});
