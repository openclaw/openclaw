/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { PresenceEntry } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context-types.ts";
import { t } from "../../i18n/index.ts";
import { invalidateConfigConnection } from "../../lib/config/config-state-model.ts";
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
  waitForRenderedModalDialog as waitForDialog,
} from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
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
    JSON.stringify({ version: 1, deviceId: "00", publicKey: "AA", privateKey: "AA" }),
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

function subscribe<T>(listeners: Set<(value: T) => void>) {
  return (listener: (value: T) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
}

function gatewayFixture(initial: ApplicationGatewaySnapshot) {
  let snapshot = initial;
  const snapshots = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const events = new Set<(event: { event: string; payload?: unknown }) => void>();
  const source = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "http://gateway.test" },
    subscribe: subscribe(snapshots),
    subscribeEvents: subscribe(events),
  } as unknown as ApplicationContext["gateway"];
  return {
    source,
    emitSnapshot(next: ApplicationGatewaySnapshot) {
      snapshot = next;
      snapshots.forEach((listener) => listener(next));
      flush();
    },
    emitEvent(event: string, payload?: unknown) {
      events.forEach((listener) => listener({ event, payload }));
      flush();
    },
    get subscriptions() {
      return snapshots.size + events.size;
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
  const [presentation, setPresentation] = createSignal({ routeData });
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
  const mounted = mountSolid(() => (
    <ApplicationProvider value={context}>
      <DevicesPage routeData={presentation().routeData} />
    </ApplicationProvider>
  ));
  const { container } = mounted;
  flush();
  const dispose = () => {
    mounted.unmount();
    flush();
  };
  cleanups.push(dispose);
  return {
    container,
    get text() {
      return container.textContent;
    },
    query: <T extends Element = Element>(selector: string) => container.querySelector<T>(selector),
    config: context.runtimeConfig.state,
    dispose,
    refreshPresentation() {
      setPresentation({ routeData });
      flush();
    },
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

function mountConnected(
  initial: Partial<DevicesPageDataState> = {},
  request?: Parameters<typeof clientFor>[0],
  access: { methods?: string[]; scopes?: string[] } = {},
) {
  const clientFixture = clientFor(request);
  const snapshot = gatewaySnapshot(clientFixture.client, true, access.methods, access.scopes);
  const fixture = gatewayFixture(snapshot);
  return { ...clientFixture, snapshot, fixture, ...mountPage(fixture, initial) };
}

function respondWith(responses: Record<string, unknown>) {
  return vi.fn(async (method: string) =>
    Object.hasOwn(responses, method) ? responses[method] : responseFor(method),
  );
}

function button(container: ParentNode, label: string) {
  return expectDefined(
    [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    ),
    `Expected ${label} button`,
  );
}

function dialogButton(label: string) {
  return button(expectDefined(currentModal(), "Expected an open dialog"), label);
}

async function selectEntryAction(container: ParentNode, action: string, name = "MacBook Pro") {
  const row = [...container.querySelectorAll(".device-entry")].find(
    (entry) => entry.querySelector(".settings-row__title")?.textContent === name,
  );
  const trigger = expectDefined(
    row?.querySelector<HTMLButtonElement>(".device-entry__menu-trigger"),
    "device actions trigger",
  );
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  expectDefined(
    row?.querySelector<HTMLButtonElement>(`[role="menuitem"][data-value="${action}"]`),
    `device action ${action}`,
  ).click();
  await Promise.resolve();
  flush();
}

function secretDialogText() {
  return text(document.body, ".secret-reveal__code")?.trim() ?? "";
}

const text = (container: ParentNode, selector: string) =>
  container.querySelector(selector)?.textContent;
const select = (container: ParentNode, label: string) =>
  container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
const requested = (request: ReturnType<typeof clientFor>["request"]) =>
  request.mock.calls.map(([method]) => method);
const currentModal = () => document.body.querySelector("openclaw-modal-dialog");
const hostAccess = { methods: ["system.info", "desktop.observe"], scopes: ["operator.admin"] };
const preloadedInventory = () => ({
  nodes: [{ nodeId: "node-1" }],
  devicesList: { paired: [], pending: [] },
});
const expectRequest = (
  request: ReturnType<typeof clientFor>["request"],
  method: string,
  params = {},
) => vi.waitFor(() => expect(request).toHaveBeenCalledWith(method, params));
const waitForText = (page: ReturnType<typeof mountPage>, value: string) =>
  vi.waitFor(() => expect(page.text).toContain(value));

function reconnect(
  fixture: ReturnType<typeof gatewayFixture>,
  snapshot: ApplicationGatewaySnapshot,
) {
  fixture.emitSnapshot({ ...snapshot, phase: "reconnecting" });
  fixture.emitSnapshot(snapshot);
}

function dismissModal(modal: Element) {
  const dismissal = new Event("modal-cancel", { bubbles: true, cancelable: true, composed: true });
  modal.dispatchEvent(dismissal);
  return dismissal;
}

async function openRotation(token: string | null) {
  stubLocalDeviceIdentity();
  const page = mountPaired(rotatingRequest(token));
  button(page.container, t("devices.inventory.rotate")).click();
  return waitForDialog(document.body);
}

async function expectNoModal() {
  await vi.waitFor(() => expect(currentModal()).toBeNull());
}

function mountPaired(request: Parameters<typeof clientFor>[0]) {
  return mountConnected(
    {
      devicesList: { paired: [pairedDevice], pending: [] },
      nodes: [{ nodeId: "node-1", displayName: "Office Mac" }],
    },
    request,
  );
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

it("preserves matching offline route data until provider replacement", () => {
  const fixture = gatewayFixture(gatewaySnapshot(null, false));
  const page = mountPage(fixture, {
    nodes: [{ nodeId: "preloaded", displayName: "Preloaded Mac" }],
  });
  expect(page.text).toContain("Preloaded Mac");
  fixture.emitEvent("presence", {
    presence: [{ host: "Stale presence", instanceId: "stale", ts: 1_000 }],
  });
  expect(page.text).toContain("Stale presence");
  page.replaceGateway(gatewayFixture(gatewaySnapshot(null, false)));
  expect(page.text).not.toContain("Preloaded Mac");
  expect(page.text).not.toContain("Stale presence");
});

it("retains inventory and an edited approval policy through a same-client reconnect", async () => {
  const { client } = clientFor();
  const snapshot = gatewaySnapshot(client, true, [], ["operator.admin"]);
  const fixture = gatewayFixture(snapshot);
  const page = mountPage(fixture, {
    nodes: [{ nodeId: "retained", displayName: "Retained Mac" }],
    execApprovalsSnapshot: {
      path: "/synthetic/exec-approvals.json",
      exists: true,
      hash: "original-base",
      file: { version: 1, defaults: { security: "deny" } },
    },
    execApprovalsForm: { version: 1, defaults: { security: "deny" } },
  });
  const policy = select(page.container, "Mode")!;
  expect(policy).not.toBeNull();
  policy.value = "allowlist";
  policy.dispatchEvent(new Event("change", { bubbles: true }));
  flush();
  page.config.configForm = { tools: { exec: { node: "draft-node" } } };
  invalidateConfigConnection(page.config);
  fixture.emitSnapshot({ ...snapshot, phase: "reconnecting", hello: null });
  expect(page.text).toContain("Retained Mac");
  expect(select(page.container, "Mode")?.value).toBe("allowlist");
  expect(button(page.container, "Save").disabled).toBe(true);
  expect(select(page.container, "Node")?.value).toBe("draft-node");
  fixture.emitSnapshot(snapshot);
  expect(select(page.container, "Mode")?.value).toBe("allowlist");
  page.replaceGateway(gatewayFixture(gatewaySnapshot(null, false)));
  expect(page.text).not.toContain("Retained Mac");
  expect(select(page.container, "Mode")).toBeNull();
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
  await expectRequest(request, "node.list");
  expect(page.text).not.toContain("Stale Mac");
});

it.each(["node.runnerInventory.changed", "node.hostStats"])(
  "quietly reloads node status for %s",
  async (event) => {
    const nodes = createDeferred<{ nodes: Array<Record<string, unknown>> }>();
    const page = mountConnected(
      {
        nodes: [{ nodeId: "node-1", displayName: "Office Mac", connected: false }],
        devicesList: { paired: [], pending: [] },
        lastError: "Earlier operator action failed",
      },
      respondWith({ "node.list": nodes.promise }),
    );
    page.fixture.emitEvent(event, { nodeId: "node-1" });
    expect(page.request).toHaveBeenCalledWith("node.list", {});
    expect(page.text).toContain("Office Mac");
    expect(page.text).toContain("Earlier operator action failed");
    nodes.resolve({ nodes: [{ nodeId: "node-1", displayName: "Current Mac", connected: true }] });
    await waitForText(page, "Current Mac");
    page.refreshPresentation();
    expect(page.text).toContain("Current Mac");
    expect(page.text).not.toContain("Office Mac");
  },
);

it.each([
  ["advertised", ["system.info", "desktop.observe"], ["operator.admin"], true, true, true],
  ["unadvertised", [], undefined, true, false, false],
  ["unknown features", undefined, undefined, true, false, false],
  ["read-only", ["system.info", "desktop.observe"], ["operator.read"], true, true, false],
  [
    "session-only",
    ["system.info", "desktop.observe"],
    ["operator.sessions.read", "operator.sessions.write"],
    false,
    false,
    false,
  ],
] satisfies Array<[string, string[] | undefined, string[] | undefined, boolean, boolean, boolean]>)(
  "loads only available host details for %s connections",
  async (_name, methods, scopes, read, systemInfo, desktop) => {
    const { client, request } = clientFor();
    const snapshot = gatewaySnapshot(client, true, methods, scopes);
    if (methods === undefined && snapshot.hello) {
      delete snapshot.hello.features;
    }
    const page = mountPage(gatewayFixture(snapshot), {
      devicesList: { paired: [], pending: [] },
    });
    await vi.waitFor(() => expect(page.text?.includes("Gateway host")).toBe(read));
    await Promise.resolve();
    flush();
    for (const methodName of ["system-presence", "node.list"]) {
      expect(requested(request).includes(methodName)).toBe(read);
    }
    expect(requested(request).includes("system.info")).toBe(systemInfo);
    expect(requested(request).includes("environments.list")).toBe(desktop);
    await vi.waitFor(() => {
      expect(page.query(".device-entry__desktop") !== null).toBe(desktop);
      expect(page.query(".device-resource--load") !== null).toBe(systemInfo);
    });
  },
);

it("refreshes host details with quiet inventory polling and stops after disposal", async () => {
  vi.useFakeTimers();
  const page = mountConnected({}, undefined, hostAccess);
  const { request, fixture } = page;
  await vi.advanceTimersByTimeAsync(0);
  flush();
  request.mockClear();
  await vi.advanceTimersByTimeAsync(60_000);
  flush();
  expect(requested(request).filter((method) => method === "system.info")).toHaveLength(2);
  expect(requested(request).filter((method) => method === "environments.list")).toHaveLength(2);
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
  reconnect(fixture, snapshot);
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(2);
});

it.each(["reconnect", "provider replacement", "dispose", "remount"])(
  "retires in-flight inventory and host details across %s",
  async (transition) => {
    const oldNodes = createDeferred<unknown>();
    const newNodes = createDeferred<unknown>();
    const systemInfo = createDeferred<typeof deviceSystemInfo>();
    const environments = createDeferred<{ environments: typeof deviceDesktopEnvironments }>();
    const responses = {
      "node.list": oldNodes.promise,
      "system.info": systemInfo.promise,
      "environments.list": environments.promise,
    };
    const initialPage = mountConnected({}, respondWith(responses), hostAccess);
    const { request, fixture, snapshot } = initialPage;
    let page: ReturnType<typeof mountPage> = initialPage;
    const nodeCalls = () => requested(request).filter((method) => method === "node.list").length;
    await vi.waitFor(() => {
      expect(nodeCalls()).toBe(1);
      expect(request).toHaveBeenCalledWith("environments.list", {}, expect.anything());
    });
    request.mockImplementation(
      respondWith({
        "node.list": newNodes.promise,
        "system.info": { ...deviceSystemInfo, loadAverage: [8, 4, 2] },
        "environments.list": { environments: [] },
      }),
    );
    if (transition === "reconnect") {
      reconnect(fixture, snapshot);
    } else if (transition === "provider replacement") {
      page.replaceGateway(gatewayFixture(snapshot));
    } else {
      page.dispose();
      if (transition === "remount") {
        page = mountPage(fixture);
      }
    }
    if (transition !== "dispose") {
      await vi.waitFor(() => {
        expect(nodeCalls()).toBe(2);
        expect(text(page.container, ".device-resource--load")).toContain("8.0");
      });
    }
    oldNodes.resolve({ nodes: [{ nodeId: "old", displayName: "Old Mac" }] });
    systemInfo.resolve(deviceSystemInfo);
    environments.resolve({ environments: deviceDesktopEnvironments });
    await Promise.all([oldNodes.promise, systemInfo.promise, environments.promise]);
    await Promise.resolve();
    flush();
    expect(page.text).not.toContain("Old Mac");
    await vi.waitFor(() => {
      expect(page.query(".device-entry__desktop")).toBeNull();
      if (transition !== "dispose") {
        expect(text(page.container, ".device-resource--load")).toContain("8.0");
      }
    });
    newNodes.resolve({ nodes: [{ nodeId: "new", displayName: "New Mac" }] });
    if (transition !== "dispose") {
      await waitForText(page, "New Mac");
    }
  },
);

it.each(["device", "node"])(
  "coalesces a %s refresh while an older list is loading",
  async (kind) => {
    const methodName = kind === "device" ? "device.pair.list" : "node.list";
    const stale = createDeferred<unknown>();
    const refreshed = createDeferred<unknown>();
    let calls = 0;
    const request = vi.fn(async (method: string) =>
      method === methodName
        ? ++calls === 1
          ? stale.promise
          : refreshed.promise
        : responseFor(method),
    );
    const page = mountConnected({}, request);
    const { fixture } = page;
    await vi.waitFor(() => expect(calls).toBe(1));
    fixture.emitEvent(kind === "device" ? "device.pair.changed" : "node.hostStats", {});
    stale.resolve(
      kind === "device"
        ? { paired: [{ deviceId: "device-1", displayName: "Kitchen Mac" }], pending: [] }
        : { nodes: [{ nodeId: "node-1", displayName: "Kitchen Mac" }] },
    );
    await vi.waitFor(() => expect(calls).toBe(2));
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
    await waitForText(page, "Studio Mac");
    expect(request.mock.calls.filter(([method]) => method === methodName)).toHaveLength(2);
  },
);

it("keeps initial and event-driven pairing and exec-approval loads gated by scopes", async () => {
  const page = mountConnected({}, undefined, {
    methods: ["node.list", "device.pair.list", "exec.approvals.get"],
    scopes: ["operator.read"],
  });
  const { request, fixture } = page;
  await expectRequest(request, "node.list");
  fixture.emitEvent("presence", {
    presence: [{ instanceId: "browser-1", ts: 2_000, reason: "connect" }],
  });
  fixture.emitEvent("device.pair.changed", {});
  await Promise.resolve();
  flush();
  expect(requested(request)).not.toContain("device.pair.list");
  expect(requested(request)).not.toContain("exec.approvals.get");
  expect(button(page.container, t("devices.pairing.button")).disabled).toBe(true);
});

it.each([
  ["node disconnects", "node", ["node"], ["operator"]],
  ["merged node-role presence disconnects", "node", ["operator", "node"], ["operator"]],
  ["operator disconnects", "operator", ["node"], ["operator"]],
  ["node disconnects with a roleless operator", "node", ["node"], undefined],
  ["activity updates", "activity", ["node"], ["operator"]],
] satisfies Array<[string, string, string[], string[] | undefined]>)(
  "refreshes mixed-role inventory only for connectivity changes: %s",
  async (_name, role, nodeRoles, operatorRoles) => {
    const { fixture, request } = mountConnected(preloadedInventory());
    const node: PresenceEntry = {
      deviceId: "mixed-role-device",
      instanceId: role === "activity" ? undefined : "node",
      roles: nodeRoles,
      reason: "connect",
      ts: 2_000,
    };
    const operator: PresenceEntry = {
      deviceId: "mixed-role-device",
      instanceId: role === "activity" ? undefined : "operator-session",
      roles: operatorRoles,
      reason: "connect",
      ts: 1_000,
    };
    fixture.emitEvent("presence", { presence: [node, operator] });
    await expectRequest(request, "device.pair.list");
    await Promise.resolve();
    flush();
    request.mockClear();
    const presence = [node, operator];
    fixture.emitEvent("presence", {
      presence:
        role === "activity"
          ? presence.map((entry) =>
              Object.assign({}, entry, { lastInputSeconds: 3, ts: entry.ts + 100 }),
            )
          : [
              role === "node" ? { ...node, reason: "disconnect" } : node,
              role === "operator" ? { ...operator, reason: "disconnect" } : operator,
            ],
    });
    if (role === "activity") {
      await Promise.resolve();
      flush();
      expect(request).not.toHaveBeenCalled();
    } else {
      await expectRequest(request, "node.list");
      expect(request).toHaveBeenCalledWith("device.pair.list", {});
    }
  },
);

it.each(["removal", "alias"])(
  "retains a pending %s dialog through reconnect and cancels it on fresh pairing denial",
  async (kind) => {
    const request = vi.fn(async (method: string) => responseFor(method));
    const page = mountPaired(request);
    await selectEntryAction(page.container, kind === "alias" ? "editAlias" : "remove");
    await waitForDialog(document.body);
    if (kind === "alias") {
      const input = document.body.querySelector<HTMLInputElement>('input[name="value"]')!;
      input.value = "Draft device alias";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
    }
    const label = kind === "alias" ? t("common.save") : t("devices.inventory.remove");
    expect(dialogButton(label).disabled).toBe(false);
    request.mockClear();
    page.fixture.emitSnapshot(gatewaySnapshot(page.client, false));
    expect(currentModal()).not.toBeNull();
    expect(dialogButton(label).disabled).toBe(true);
    expect(request).not.toHaveBeenCalled();
    page.fixture.emitSnapshot(gatewaySnapshot(page.client));
    expect(dialogButton(label).disabled).toBe(false);
    if (kind === "alias") {
      expect(document.body.querySelector<HTMLInputElement>('input[name="value"]')?.value).toBe(
        "Draft device alias",
      );
    }
    page.fixture.emitSnapshot(gatewaySnapshot(page.client, true, [], ["operator.read"]));
    await expectNoModal();
    expect(page.text).not.toContain("MacBook Pro");
    expect(page.text).toContain("Office Mac");
    page.fixture.emitSnapshot(gatewaySnapshot(page.client, true, [], []));
    expect(page.query(".device-entry")).toBeNull();
    expect(requested(request)).not.toContain("device.pair.remove");
    expect(requested(request)).not.toContain("device.pair.rename");
  },
);

it("rejects a device pairing request after the in-app dialog is confirmed", async () => {
  const page = mountConnected({
    nodes: [{ nodeId: "node-1" }],
    devicesList: {
      paired: [],
      pending: [{ requestId: "request-1", deviceId: "device-1", displayName: "Browser" }],
    },
  });
  button(page.container, t("devices.inventory.reject")).click();
  const { dialog } = await waitForDialog(document.body);
  expect(dialog.getAttribute("aria-label")).toBe(t("devices.inventory.rejectDevicePromptTitle"));
  dialogButton(t("devices.inventory.reject")).click();
  await expectRequest(page.request, "device.pair.reject", { requestId: "request-1" });
  await expectNoModal();
});

it("issues no node pairing request when the dialog is cancelled", async () => {
  const page = mountConnected({
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
  await selectEntryAction(page.container, "reject", "Pending node");
  await waitForDialog(document.body);
  page.request.mockClear();
  dialogButton(t("common.cancel")).click();
  await expectNoModal();
  expect(page.request).not.toHaveBeenCalled();
});

it.each(["connection resets", "pairing access is lost"])(
  "drops a token revoke after %s during confirmation",
  async (transition) => {
    const request = vi.fn(async (method: string) => responseFor(method));
    const page = mountPaired(request);
    button(page.container, t("devices.inventory.revoke")).click();
    const { dialog } = await waitForDialog(document.body);
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
    }
    if (transition === "connection resets") {
      expect(dialogButton(t("devices.inventory.revoke")).disabled).toBe(true);
      dialogButton(t("devices.inventory.revoke")).click();
      expect(currentModal()).not.toBeNull();
      dialogButton(t("common.cancel")).click();
    }
    await expectNoModal();
    expect(requested(request)).not.toContain("device.token.revoke");
  },
);

it("reveals a rotated token with a copy control until it is acknowledged", async () => {
  const { dialog, modal } = await openRotation(ROTATED_TOKEN);
  expect(dialog.getAttribute("aria-label")).toBe(
    t("devices.inventory.rotatePromptTitle", { role: "operator" }),
  );
  expect(secretDialogText()).toBe(ROTATED_TOKEN);
  expect(document.body.querySelector(".chat-copy-btn")).toBeInstanceOf(HTMLButtonElement);
  const dismissal = dismissModal(modal);
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
    await vi.waitFor(() => expect(requested(request)).toContain("device.token.rotate"));
    page.fixture.emitSnapshot(gatewaySnapshot(page.client, false));
    rotated.resolve(outcome);
    await waitForDialog(document.body);
    expect(secretDialogText()).toBe(ROTATED_TOKEN);
    dialogButton(t("devices.inventory.rotateAcknowledge")).click();
    await expectNoModal();
  } finally {
    rotated.resolve(outcome);
  }
});

it("explains a cross-device rotation the Gateway withheld the token for", async () => {
  const { dialog } = await openRotation(null);
  expect(dialog.getAttribute("aria-label")).toBe(
    t("devices.inventory.rotateWithheldTitle", { device: "MacBook Pro" }),
  );
  expect(document.body.textContent).toContain(t("devices.inventory.rotateWithheldNext"));
  expect(text(document.body, ".secret-reveal__callout")).toContain(
    t("devices.inventory.rotateWithheldException"),
  );
  expect(document.body.querySelector(".secret-reveal__status")).not.toBeNull();
  expect(text(document.body, ".secret-reveal__note")).toContain(
    t("devices.inventory.rotateWithheldNote"),
  );
  expect(document.body.querySelector(".secret-reveal__code")).toBeNull();
  expect(document.body.querySelector(".chat-copy-btn")).toBeNull();
  expect(dialogButton(t("common.close")).className).toBe("btn secret-reveal__dismiss");
  dialogButton(t("common.close")).click();
  await expectNoModal();
});

it("lets a dismissal gesture close the withheld-rotation outcome", async () => {
  const { modal } = await openRotation(null);
  const dismissal = dismissModal(modal);
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
  await waitForText(page, "rotate refused");
  expect(currentModal()).toBeNull();
});
