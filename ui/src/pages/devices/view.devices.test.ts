/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { openDesktopFocus } from "../../components/desktop/desktop-focus-window.ts";
import { showToast } from "../../lib/toast.ts";
import {
  createDevicesViewProps,
  createOfflineDeviceNode,
  deviceSystemInfo,
} from "../../test-helpers/devices-fixtures.ts";
import {
  renderDevicesContainer as renderView,
  renderDevicesInto as updateView,
  getDevicesSection as getSection,
  getDeviceSettingsRow as getRow,
} from "../../test-helpers/devices-view.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { DevicesProps } from "./view.types.ts";

vi.mock("../../components/desktop/desktop-focus-window.ts", () => ({
  openDesktopFocus: vi.fn(),
}));

vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const getInventorySection = (container: Element) => getSection(container, "Paired devices");

function findElement<T extends Element = HTMLElement>(scope: ParentNode, selector: string) {
  return expectDefined(scope.querySelector<T>(selector), selector);
}
const texts = (scope: ParentNode, selector: string) =>
  Array.from(scope.querySelectorAll(selector), (node) => node.textContent?.trim());
const menuItem = (scope: ParentNode, value: string) =>
  findElement<HTMLButtonElement>(scope, `[role="menuitem"][data-value="${value}"]`);

function getPendingDeviceDetails(container: Element): string[] {
  const item = findElement(getSection(container, "Pending approval"), ".settings-row");
  const meta = description(item)?.replace(/\s+/gu, " ").trim() ?? "";
  const access = Array.from(item.querySelectorAll("dt"))
    .filter((label) => /Requested access|Approved access/u.test(label.textContent ?? ""))
    .map((label) => {
      const prefix = label.textContent === "Requested access" ? "requested" : "approved now";
      return `${prefix}: ${label.nextElementSibling?.textContent?.trim()}`;
    });
  return [meta, ...access];
}

function findButton(scope: Element, label: string): HTMLButtonElement {
  return expectDefined(
    Array.from(scope.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    ),
    `Expected button ${label}`,
  );
}

async function selectMenuItem(scope: Element, value: string): Promise<HTMLButtonElement> {
  const trigger = findElement<HTMLButtonElement>(scope, ".device-entry__menu-trigger");
  if (trigger.getAttribute("aria-expanded") !== "true") {
    trigger.click();
    await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  }
  const item = menuItem(scope, value);
  item.click();
  await Promise.resolve();
  flush();
  return item;
}

type DeviceList = NonNullable<DevicesProps["devicesList"]>;
type RenderProps = Partial<DevicesProps> & Partial<DeviceList>;
type Paired = DeviceList["paired"][number];
type Pending = DeviceList["pending"][number];
type Node = DevicesProps["nodes"][number];
function renderDevices({ paired = [], pending = [], ...props }: RenderProps) {
  return renderView({ ...props, devicesList: { paired, pending } });
}

function pairedDevice(deviceId: string, displayName: string, extra: Partial<Paired> = {}) {
  return { deviceId, displayName, roles: ["operator"], ...extra };
}

function pendingDevice(extra: Partial<Pending> = {}): Pending {
  return {
    requestId: "req-1",
    deviceId: "device-1",
    displayName: "Device One",
    role: "operator",
    scopes: ["operator.admin"],
    ts: Date.now(),
    ...extra,
  };
}

function makeNode(nodeId: string, displayName: string, extra: Partial<Node> = {}) {
  return { nodeId, displayName, connected: true, paired: true, ...extra };
}

const description = (row: Element) =>
  row.querySelector(".device-entry__body > .settings-row__desc")?.textContent;
const imageLabel = (row: Element) => row.querySelector('[role="img"]')?.getAttribute("aria-label");

it.each([false, true])(
  "matches normalized device IDs but not mismatched keys: %s",
  (mismatched) => {
    const container = renderDevices({
      pending: [
        pendingDevice(
          mismatched
            ? { publicKey: "new-key" }
            : {
                deviceId: " device-1 ",
                scopes: ["operator.admin", "operator.read"],
              },
        ),
      ],
      paired: [
        pairedDevice("device-1", "Device One", {
          scopes: ["operator.read"],
          ...(mismatched ? { publicKey: "old-key" } : {}),
        }),
      ],
    });
    const details = getPendingDeviceDetails(container);
    expect(details[0]).toMatch(
      mismatched
        ? /^new device pairing request · requested /u
        : /^scope upgrade requires approval · requested /u,
    );
    expect(details.slice(1)).toEqual([
      "requested: roles: operator · scopes: operator.admin, operator.read, operator.write",
      ...(mismatched ? [] : ["approved now: roles: operator · scopes: operator.read"]),
    ]);
  },
);

it("falls back to roles when role is absent", () => {
  const container = renderDevices({
    pending: [
      pendingDevice({
        deviceId: "device-2",
        displayName: undefined,
        role: undefined,
        roles: ["node", "operator"],
        scopes: ["operator.read"],
      }),
    ],
  });
  const details = getPendingDeviceDetails(container);

  expect(details[1]).toBe("requested: roles: node, operator · scopes: operator.read");
});

it.each([
  { load: 18, free: 24, diskFree: 240, tone: "warn" },
  { load: 28, free: 8, diskFree: 80, tone: "danger" },
])("renders node resource pressure as $tone", ({ load, free, diskFree, tone }) => {
  const container = renderView({
    nodes: [
      makeNode("studio", "Studio", {
        platform: "macos 27.0",
        modelIdentifier: "Mac15,14",
        version: "2026.8.1",
        hostStats: {
          cpuCount: 24,
          loadAverage: [load, 2.8, 2.4],
          memoryTotalBytes: 192 * 1024 ** 3,
          memoryFreeBytes: free * 1024 ** 3,
          diskTotalBytes: 2048 * 1024 ** 3,
          diskAvailableBytes: diskFree * 1024 ** 3,
          updatedAtMs: 1000,
        },
      }),
      makeNode("without-stats", "Without stats"),
    ],
  });
  const row = getRow(container, "Studio");
  expect(row.querySelectorAll(`.device-resources .session-context-meter--${tone}`)).toHaveLength(3);
  expect(row.querySelector(".device-resource")?.getAttribute("title")).toContain(
    `${load.toFixed(2)} / 2.80 / 2.40 on 24 cores`,
  );
  expect(description(row)).toContain("macOS 27.0 · Mac Studio · Mac15,14 · 2026.8.1");
  expect(getRow(container, "Without stats").querySelector(".device-resources")).toBeNull();
});

it("hides only meters whose optional inputs are absent", () => {
  const container = renderView({
    nodes: [
      {
        nodeId: "memory",
        displayName: "Memory only",
        paired: true,
        hostStats: {
          cpuCount: 8,
          memoryTotalBytes: 32 * 1024 ** 3,
          memoryFreeBytes: 16 * 1024 ** 3,
          updatedAtMs: 1000,
        },
      },
    ],
  });
  const meters = getRow(container, "Memory only").querySelectorAll(".device-resource");
  expect(meters).toHaveLength(1);
  expect(meters[0]?.textContent).toContain("16 / 32 GB");
});

it.each(["gateway", "node:studio"])(
  "opens the recorded %s desktop environment in a focus window",
  async (environmentId) => {
    // Settings routes hide the docked panel, so the row must open the standalone window.
    const container = renderView({
      basePath: "/ui",
      presence: [{ host: "Gateway", mode: "gateway", ts: 1000 }],
      nodes: [makeNode("studio", "Studio")],
      desktopEnvironments: [
        { id: environmentId, type: "host", status: "available", desktop: true },
      ],
    });
    const row = getRow(container, environmentId === "gateway" ? "Gateway" : "Studio");
    expect(container.querySelectorAll(".device-entry__desktop")).toHaveLength(1);
    findButton(row, "Desktop").click();
    expect(openDesktopFocus).toHaveBeenCalledExactlyOnceWith("/ui", environmentId);
    vi.mocked(openDesktopFocus).mockClear();
    await selectMenuItem(row, "desktop");
    expect(openDesktopFocus).toHaveBeenCalledExactlyOnceWith("/ui", environmentId);
  },
);

it("does not infer Desktop availability from commands", () => {
  const container = renderView({
    nodes: [
      { nodeId: "studio", displayName: "Studio", paired: true, commands: ["desktop.stream"] },
    ],
    desktopEnvironments: [
      { id: "node:studio", type: "node", status: "available", desktop: undefined },
      { id: "node:other", type: "node", status: "available", desktop: true },
    ],
  });
  const row = getRow(container, "Studio");
  expect(row.querySelector(".device-entry__desktop")).toBeNull();
  const title = findElement(row, '[aria-disabled="true"]').title;
  for (const hint of ["Desktop sharing", "pending desktop capability request"]) {
    expect(title).toContain(hint);
  }
  expect(row.querySelector(".device-entry__facts")?.textContent).toContain("desktop.stream");
});

it("renders Gateway resources and uptime from system info", () => {
  const container = renderView({
    presence: [{ host: "Gateway", mode: "gateway", ts: 1000 }],
    gatewaySystemInfo: {
      ...deviceSystemInfo,
      uptimeMs: (11 * 24 + 4) * 3600000,
      loadAverage: [3.2, 2.8, 2.4],
      diskTotalBytes: 2 * 1024 ** 4,
      diskAvailableBytes: 1.2 * 1024 ** 4,
    },
  });
  const row = getRow(container, "Gateway");
  expect(row.querySelectorAll(".device-resource")).toHaveLength(3);
  expect(row.textContent).toContain("load 3.2");
  expect(row.textContent).toContain("1.2 TB free");
  expect(description(row)).toContain("up 11d 4h");
});

it("keeps the paired-devices empty state when only other sections have rows", () => {
  const container = renderDevices({
    pending: [pendingDevice({ scopes: [] })],
    presence: [{ instanceId: "probe-1", host: "laptop", mode: "probe", ts: 1_000 }],
  });

  expect(findElement(getInventorySection(container), ".settings-empty").textContent).toContain(
    "No paired devices.",
  );
});

it("renders one row per machine with duplicates collapsed", () => {
  const container = renderDevices({
    paired: [
      pairedDevice("mac-new", "MacBook", { roles: ["operator", "node"], lastSeenAtMs: 3_000 }),
      pairedDevice("mac-old", "MacBook", {
        roles: ["operator", "node"],
        approvedVia: "silent",
        lastSeenAtMs: 1_000,
      }),
    ],
    nodes: [makeNode("mac-new", "MacBook")],
  });
  const section = getInventorySection(container);

  expect(texts(section, ".settings-row__title")).toEqual(["MacBook", "MacBook"]);
  const dups = section.querySelector(".device-group__dups");
  expect(dups?.querySelector("summary")?.textContent).toContain("1 older pairing");
  expect(dups?.textContent).toContain("mac-old");
  expect(findButton(section, "Clean up 1 stale")).toBeInstanceOf(HTMLButtonElement);
});

it("routes the danger menu item through the existing inventory removal request", async () => {
  const onInventoryRemove = vi.fn();
  const container = renderDevices({
    paired: [pairedDevice("op-only", "Browser")],
    onInventoryRemove,
  });

  const row = getRow(container, "Browser");
  expect(row.querySelector(".device-entry__remove")).toBeNull();
  expect((await selectMenuItem(row, "remove")).dataset.variant).toBe("danger");

  expect(onInventoryRemove).toHaveBeenCalledExactlyOnceWith({
    id: "op-only",
    name: "Browser",
    removeNode: false,
    removeDevice: true,
  });
});

it("routes the Edit alias menu item to the device with its current alias", async () => {
  const renamed: Array<{ id: string; name: string; operatorLabel?: string }> = [];
  const container = renderDevices({
    paired: [
      pairedDevice("alias-device", "LIN-5F196050F5D", { operatorLabel: "Office node" }),
      pairedDevice("unaliased-device", "Fresh laptop"),
    ],
    onDeviceRename: (device) => renamed.push(device),
  });

  await selectMenuItem(getRow(container, "Office node"), "editAlias");
  await selectMenuItem(getRow(container, "Fresh laptop"), "editAlias");

  expect(renamed).toEqual([
    { id: "alias-device", name: "Office node", operatorLabel: "Office node" },
    { id: "unaliased-device", name: "Fresh laptop", operatorLabel: undefined },
  ]);
});

it("keeps focus on Copy when an inventory refresh adds preceding approval actions", async () => {
  const node = { nodeId: "node-one", displayName: "Node One", paired: true, connected: true };
  const props = createDevicesViewProps({ nodes: [node] });
  const container = renderView(props);
  const copy = menuItem(container, "copy");
  const trigger = findElement<HTMLButtonElement>(
    getRow(container, "Node One"),
    ".device-entry__menu-trigger",
  );
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  copy.focus();
  expect(document.activeElement).toBe(copy);

  updateView(container, {
    ...props,
    nodes: [{ ...node, approvalState: "pending-reapproval", pendingRequestId: "request-new" }],
  });

  expect(
    Array.from(
      container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      (item) => item.dataset.value,
    ),
  ).toEqual(["approve", "reject", "copy", "remove"]);
  expect(container.querySelector('[role="menuitem"][data-value="copy"]')).toBe(copy);
  expect(document.activeElement).toBe(copy);
});

it.each([true, false])(
  "reports the device ID copy outcome when clipboard succeeds: %s",
  async (succeeds) => {
    const writeText = succeeds
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error("Denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const container = renderDevices({
      canManagePairing: false,
      paired: [pairedDevice("copy-device-id", "Copy device")],
    });
    const row = getRow(container, "Copy device");
    expect((await selectMenuItem(row, "copy")).disabled).toBe(false);
    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({
        message: succeeds ? "Device ID copied" : "Copy failed",
      }),
    );
    expect(writeText).toHaveBeenCalledExactlyOnceWith("copy-device-id");
  },
);

it("renders approve and reject actions for pending node approvals", async () => {
  const approvals: string[] = [];
  const rejections: string[] = [];
  const container = renderView({
    nodes: [
      makeNode("node-pending", "clawmac", {
        approvalState: "pending-reapproval",
        pendingRequestId: "node-req-1",
      }),
    ],
    onNodeApprove: (requestId) => approvals.push(requestId),
    onNodeReject: (requestId) => rejections.push(requestId),
  });
  const section = getInventorySection(container);

  expect(section.textContent).toContain("approval needed");
  expect(texts(section, 'button:not([role="menuitem"])')).not.toContain("Approve");
  await selectMenuItem(section, "approve");
  await selectMenuItem(section, "reject");
  expect(rejections).toEqual(["node-req-1"]);
  expect(approvals).toEqual(["node-req-1"]);
});

it("keeps installed workers quiet and warns when the retained bundle is missing", () => {
  const container = renderView({
    nodes: [
      makeNode("node-installed", "Installed Mac", {
        workerSlots: { total: 2, available: 1 },
        workerBundle: { status: "installed", version: "2026.8.9" },
      }),
      makeNode("node-missing", "Missing Mac", { workerBundle: { status: "missing" } }),
    ],
  });
  const section = getInventorySection(container);
  const installed = getRow(section, "Installed Mac");
  const missing = getRow(section, "Missing Mac");

  expect(description(installed)).toContain("Worker 2026.8.9");
  expect(imageLabel(installed)).toBe("1 of 2 slots busy");
  expect(installed.getAttribute("title")).toBe("1 of 2 slots busy");
  expect(description(installed)).not.toContain("Worker slots");
  expect(
    texts(installed, ".settings-status").filter((value) => value === "connected"),
  ).toHaveLength(1);
  expect(texts(installed, ".settings-status")).not.toContain("worker missing");
  expect(
    texts(missing, ".settings-status").filter((value) => value === "worker missing"),
  ).toHaveLength(1);
  expect(
    Array.from(missing.querySelectorAll<HTMLElement>("[title]"))
      .find((element) => element.textContent?.trim() === "worker missing")
      ?.getAttribute("title"),
  ).toBe(
    "The Gateway-managed worker bundle is missing. Start a new session on this device to reinstall it.",
  );
});

it("shows device and Gateway version drift", () => {
  const versions: Array<[string, string, string, string]> = [
    ["old", "Older Mac", "19.4", "2026.6.11"],
    ["current", "Current Mac", "19.5", "2026.7.2"],
    ["newer", "Newer Mac", "19.6", "2026.8.1"],
  ];
  const container = renderView({
    gatewayVersion: "2026.7.2",
    nodes: [
      ...versions.map(([id, name, version, coreVersion]) =>
        makeNode(`node-${id}`, name, { version, coreVersion, uiVersion: version }),
      ),
      makeNode("legacy-linux", "Legacy Linux", { platform: "linux", version: "2026.6.10" }),
    ],
  });
  const driftStatuses = Array.from(
    getInventorySection(container).querySelectorAll<HTMLElement>("[title]"),
  ).filter((element) => element.textContent?.trim() === "version drift");

  expect(driftStatuses).toHaveLength(3);
  expect(
    driftStatuses
      .map((status) => status.getAttribute("title"))
      .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
  ).toEqual([
    "Device 2026.6.10; Gateway 2026.7.2. Update the older component to align the fleet.",
    "Device 2026.6.11; Gateway 2026.7.2. Update the older component to align the fleet.",
    "Device 2026.8.1; Gateway 2026.7.2. Update the older component to align the fleet.",
  ]);
});

it("shows node-only offline affordances while preserving mixed-role device liveness", () => {
  const container = renderDevices({
    paired: [
      pairedDevice("windows-mixed", "Mixed-role Windows", {
        platform: "Windows 11",
        roles: ["operator", "node"],
        connected: true,
      }),
    ],
    nodes: [
      makeNode("windows-mixed", "Mixed-role Windows", {
        platform: "Windows 11",
        connected: false,
        workerSlots: { total: 8, available: 0 },
        hostStats: createOfflineDeviceNode().hostStats,
      }),
    ],
  });
  const section = getInventorySection(container);
  const row = getRow(section, "Mixed-role Windows");

  expect(section.textContent).toContain("1 of 1 connected");
  expect(row.querySelector('.settings-row__control [role="img"]')?.getAttribute("aria-label")).toBe(
    "Slot utilization unavailable",
  );
  expect(row.querySelectorAll(".device-resources .session-context-meter--stale")).toHaveLength(3);
  expect(row.querySelector(".device-resource__label")?.textContent).toContain("27d ago");
  expect(row.querySelectorAll(".capacity-meter-pips__pip--filled")).toHaveLength(0);
  expect(texts(row, ".settings-status")).toEqual(["offline", "manual wake required"]);
});

it("preserves the slot-less exec affordance through node inventory", () => {
  const container = renderView({
    nodes: [makeNode("exec", "Exec host", { caps: ["codex.exec-server"], commands: [] })],
  });
  const row = getRow(getInventorySection(container), "Exec host");
  expect(imageLabel(row)).toBe("Codex exec");
  expect(row.querySelector(".capacity-meter-pips, .session-context-meter")).toBeNull();
});

it("shows token rows with rotate and revoke inside entry details", () => {
  const onDeviceRotate = vi.fn();
  const onDeviceRevoke = vi.fn();
  const container = renderDevices({
    paired: [
      pairedDevice("device-1", "Device One", {
        scopes: ["operator.read"],
        tokens: [{ role: "operator", scopes: ["operator.read"], createdAtMs: Date.now() }],
      }),
    ],
    onDeviceRotate,
    onDeviceRevoke,
  });
  const section = getInventorySection(container);

  const facts = findElement(section, ".device-entry__facts");
  expect(facts.querySelector("dt")?.textContent).toBe("Device ID");
  expect(facts.querySelector("dd[title='device-1']")?.textContent).toBe("device-1");
  expect(facts.querySelector(".device-capability--scope")?.textContent).toBe("operator.read");
  const tokenRow = findElement(facts, "table tbody tr");
  expect(texts(tokenRow, "td").slice(0, 3)).toEqual(["operator", "active", "operator.read"]);
  expect(facts.querySelector(".muted")).toBeNull();
  findButton(section, "Rotate").click();
  expect(onDeviceRotate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: "device-1", name: "Device One" }),
    "operator",
    ["operator.read"],
  );
  findButton(section, "Revoke").click();
  expect(onDeviceRevoke).toHaveBeenCalledExactlyOnceWith("device-1", "operator");
});

it("brands platform names instead of naive capitalization", () => {
  const platforms: Array<[string, string, string | undefined, string]> = [
    ["iPhone", "iOS 26.4", undefined, "iOS 26.4"],
    ["Mac", "darwin", undefined, "macOS"],
    ["Mac browser", "MacIntel", "Mac", "macOS"],
    ["iPad browser", "MacIntel", "iPad", "iPadOS"],
    ["Legacy browser", "MacIntel", undefined, "MacIntel"],
  ];
  const container = renderDevices({
    paired: platforms.map(([name, platform, deviceFamily], index) =>
      pairedDevice(`device-${index}`, name, { platform, deviceFamily }),
    ),
    presence: [
      {
        instanceId: "unpaired-ipad",
        host: "Unpaired iPad",
        platform: "MacIntel",
        deviceFamily: "iPad",
        mode: "webchat",
        ts: 1_000,
      },
    ],
  });
  expect(
    texts(getInventorySection(container), ".device-entry .settings-row__desc").some((text) =>
      text?.includes("IOS"),
    ),
  ).toBe(false);
  for (const [name, label] of [
    ...platforms.map<[string, string]>((row) => [row[0], row[3]]),
    ["Unpaired iPad", "iPadOS"],
  ] satisfies Array<[string, string]>) {
    expect(description(getRow(container, name))?.split(" · ")[0]).toBe(label);
  }
});

it("disables pairing and admin mutations with one browsing-only notice", () => {
  const onMutation = vi.fn();
  const container = renderDevices({
    onInventoryRemove: onMutation,
    onNodeApprove: onMutation,
    onNodeReject: onMutation,
    onDeviceRename: onMutation,
    nodes: [
      {
        nodeId: "node-pending",
        displayName: "Pending node",
        paired: true,
        approvalState: "pending-reapproval",
        pendingRequestId: "node-request",
      },
    ],
    canPairDevice: false,
    canManagePairing: false,
    canAdmin: false,
    pending: [
      {
        requestId: "request-1",
        deviceId: "pending-device",
        displayName: "Pending device",
        roles: ["operator"],
        scopes: ["operator.read"],
      },
    ],
    paired: [
      pairedDevice("device-1", "Device One", {
        tokens: [{ role: "operator", scopes: ["operator.read"], createdAtMs: Date.now() }],
      }),
    ],
    configForm: { agents: { entries: { main: {} } } },
    configDirty: true,
  });

  expect(container.querySelectorAll(".callout.info")).toHaveLength(1);
  expect(container.textContent).toContain("Device changes require operator.pairing");
  for (const label of ["Approve", "Reject", "Rotate", "Revoke", "Save"]) {
    expect(findButton(container, label).disabled).toBe(true);
  }
  for (const [name, action] of [
    ["Device One", "remove"],
    ["Device One", "editAlias"],
    ["Pending node", "approve"],
    ["Pending node", "reject"],
  ] satisfies Array<[string, string]>) {
    const item = menuItem(getRow(container, name), action);
    expect(item).toMatchObject({
      disabled: true,
      title: expect.stringContaining("operator.pairing"),
    });
    item.click();
  }
  expect(onMutation).not.toHaveBeenCalled();
  expect(container.textContent).toContain(
    "Browsing only. Exec approvals and node bindings require operator.admin access.",
  );
});
