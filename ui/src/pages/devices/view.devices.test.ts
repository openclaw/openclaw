/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDesktopFocus } from "../../components/desktop/desktop-focus-window.ts";
import type { InventoryRemovalRequest } from "../../lib/nodes/page-operations.ts";
import {
  createDevicesViewProps,
  createOfflineDeviceNode,
  deviceSystemInfo,
} from "../../test-helpers/devices-fixtures.ts";
import {
  renderDevicesContainer,
  renderDevicesInto,
  getDevicesSection as getSection,
  getDeviceSettingsRow as getSettingsRow,
} from "../../test-helpers/devices-view.tsx";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";

vi.mock("../../components/desktop/desktop-focus-window.ts", () => ({
  openDesktopFocus: vi.fn(),
}));

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function getInventorySection(container: Element): Element {
  return getSection(container, "Paired devices");
}

function metaParts(scope: Element | undefined): string[] {
  return Array.from(
    scope?.querySelectorAll(".device-entry__part") ?? [],
    (part) => part.textContent ?? "",
  );
}

function getPendingDeviceDetails(container: Element): string[] {
  const item = getSection(container, "Pending approval").querySelector(".settings-row");
  expect(item).toBeInstanceOf(Element);
  if (!(item instanceof Element)) {
    throw new Error("Expected pending device item");
  }
  const meta = metaParts(item).join(" · ");
  const access = Array.from(item.querySelectorAll("dt"))
    .filter((label) => /Requested access|Approved access/u.test(label.textContent ?? ""))
    .map((label) => {
      const prefix = label.textContent === "Requested access" ? "requested" : "approved now";
      return `${prefix}: ${label.nextElementSibling?.textContent?.trim()}`;
    });
  return [meta, ...access];
}

function findButton(scope: Element, label: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button ${label}`);
  }
  return button;
}

function action(scope: Element, name: string): HTMLButtonElement {
  return expectDefined(
    scope.querySelector<HTMLButtonElement>(`[data-device-action="${name}"]`),
    `device action ${name}`,
  );
}

function statusesByText(scope: Element, text: string): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(".settings-status")).filter(
    (status) => status.textContent?.trim() === text,
  );
}

describe("devices pending rendering", () => {
  it.each([
    {
      name: "normalizes pending device ids before matching paired access",
      pending: { deviceId: " device-1 ", scopes: ["operator.admin", "operator.read"] },
      pairedKey: undefined,
      summary: /^Access change needs approval · requested /u,
      approved: ["approved now: Roles: operator Scopes: operator.read"],
    },
    {
      name: "does not show upgrade context for key-mismatched pending requests",
      pending: { deviceId: "device-1", publicKey: "new-key", scopes: ["operator.admin"] },
      pairedKey: "old-key",
      summary: /^New device pairing request · requested /u,
      approved: [],
    },
  ])("$name", ({ pending, pairedKey, summary, approved }) => {
    const container = renderDevicesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-1",
            displayName: "Device One",
            role: "operator",
            ts: Date.now(),
            ...pending,
          },
        ],
        paired: [
          {
            deviceId: "device-1",
            publicKey: pairedKey,
            displayName: "Device One",
            roles: ["operator"],
            scopes: ["operator.read"],
          },
        ],
      },
    });
    const details = getPendingDeviceDetails(container);

    expect(details[0]).toMatch(summary);
    expect(details.slice(1)).toEqual([
      "requested: Roles: operator Scopes: operator.admin, operator.read, operator.write",
      ...approved,
    ]);
  });

  it("falls back to roles when role is absent", () => {
    const container = renderDevicesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-2",
            deviceId: "device-2",
            roles: ["node", "operator"],
            scopes: ["operator.read"],
            ts: Date.now(),
          },
        ],
        paired: [],
      },
    });
    const details = getPendingDeviceDetails(container);

    expect(details[1]).toBe("requested: Roles: node, operator Scopes: operator.read");
  });

  it("names each pending decision for its device and disables only the deciding row", () => {
    const pendingDevice = (requestId: string, displayName: string) => ({
      requestId,
      deviceId: `${requestId}-device`,
      displayName,
      role: "operator",
      scopes: ["operator.read"],
      ts: Date.now(),
    });
    const container = renderDevicesContainer({
      devicesList: {
        pending: [pendingDevice("req-1", "Device One"), pendingDevice("req-2", "Device Two")],
        paired: [],
      },
      devicesDeciding: [{ requestId: "req-1" }],
    });
    const decisions = Array.from(
      getSection(container, "Pending approval").querySelectorAll("button"),
    )
      .filter((button) => ["Approve", "Reject"].includes(button.textContent?.trim() ?? ""))
      .map((button) => [button.getAttribute("aria-label"), button.disabled]);

    expect(decisions).toEqual([
      ["Approve Device One", true],
      ["Reject Device One", true],
      ["Approve Device Two", false],
      ["Reject Device Two", false],
    ]);
  });

  it("gives every pending request the same weight", () => {
    const container = renderDevicesContainer({
      devicesList: {
        pending: [
          { requestId: "req-1", deviceId: "device-1", displayName: "Device One", ts: Date.now() },
          { requestId: "req-2", deviceId: "device-2", displayName: "Device Two", ts: Date.now() },
        ],
        paired: [],
      },
    });
    const section = getSection(container, "Pending approval");

    expect(section.querySelectorAll(".device-entry__approve")).toHaveLength(2);
    expect(section.querySelector(".primary")).toBeNull();
    // The section already says what these rows are.
    expect(section.querySelector(".settings-status")).toBeNull();
    expect(section.querySelector(".device-entry__meta")?.textContent).toContain("New device");
  });

  it("shows who asks and for what without opening anything", () => {
    const container = renderDevicesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-1",
            deviceId: "device-1",
            displayName: "Device One",
            role: "operator",
            scopes: ["operator.read"],
            remoteIp: "192.168.1.20",
            ts: Date.now(),
          },
        ],
        paired: [],
      },
    });
    const row = getSection(container, "Pending approval").querySelector(".device-entry");

    expect(row?.tagName).toBe("DIV");
    expect(row?.querySelector("details")).toBeNull();
    expect(row?.querySelector(".device-entry__meta")?.textContent).toContain("192.168.1.20");
    expect(row?.querySelector("dd[title='device-1']")?.textContent).toContain("device-1");
  });

  it("lists pending node approvals with device requests, with what they declare", () => {
    const approvals: string[] = [];
    const rejections: string[] = [];
    const container = renderDevicesContainer({
      devicesList: {
        pending: [{ requestId: "req-1", deviceId: "device-1", displayName: "Device One" }],
        paired: [],
      },
      nodes: [
        {
          nodeId: "node-pending",
          displayName: "clawmac",
          paired: true,
          connected: true,
          approvalState: "pending-reapproval",
          pendingRequestId: "node-req-1",
          pendingDeclaredCaps: ["screen"],
          pendingDeclaredCommands: ["screen.snapshot"],
        },
      ],
      onNodeApprove: (requestId) => approvals.push(requestId),
      onNodeReject: (requestId) => rejections.push(requestId),
    });
    const section = getSection(container, "Pending approval");

    expect(section.querySelector(".settings-count")?.textContent).toBe("2");
    const row = getSettingsRow(section, "clawmac");
    expect(row.textContent).toContain("Screen");
    expect(row.textContent).toContain("screen.snapshot");
    findButton(row, "Approve").click();
    findButton(row, "Reject").click();
    expect(approvals).toEqual(["node-req-1"]);
    expect(rejections).toEqual(["node-req-1"]);

    const inventoryRow = getSettingsRow(getInventorySection(container), "clawmac");
    expect(statusesByText(inventoryRow, "Approval needed")).toHaveLength(1);
    expect(inventoryRow.querySelector('[data-device-action="approve"]')).toBeNull();
  });

  it("disables a pending node's decision while it is in flight", () => {
    const container = renderDevicesContainer({
      nodes: [
        {
          nodeId: "node-pending",
          displayName: "clawmac",
          paired: true,
          connected: true,
          approvalState: "pending-reapproval",
          pendingRequestId: "node-req-1",
        },
      ],
      devicesDeciding: [{ requestId: "node-req-1" }],
    });
    const row = getSettingsRow(getSection(container, "Pending approval"), "clawmac");
    for (const name of ["approve", "reject"]) {
      expect(action(row, name).disabled).toBe(true);
    }
  });
});

describe("devices inventory rendering", () => {
  it.each([
    { load: 18, free: 24, diskFree: 240, tone: "warn" },
    { load: 28, free: 8, diskFree: 80, tone: "danger" },
  ])("renders node resource pressure as $tone", ({ load, free, diskFree, tone }) => {
    const container = renderDevicesContainer({
      nodes: [
        {
          nodeId: "studio",
          displayName: "Studio",
          connected: true,
          paired: true,
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
        },
        { nodeId: "without-stats", displayName: "Without stats", paired: true, connected: true },
      ],
    });
    const row = getSettingsRow(container, "Studio");
    expect(row.querySelectorAll(`.device-resource .session-context-meter--${tone}`)).toHaveLength(
      3,
    );
    // The closed row names the pressure; the meters stay on demand.
    expect(row.querySelector("summary .settings-status")?.className).toContain(tone);
    expect(row.querySelector("summary .session-context-meter")).toBeNull();
    expect(row.querySelector("summary .settings-status")?.textContent).toContain(
      `Load ${load.toFixed(1)}`,
    );
    expect(row.querySelector(".device-resource")?.getAttribute("title")).toContain(
      `${load.toFixed(2)} / 2.80 / 2.40 on 24 cores`,
    );
    expect(metaParts(row.querySelector(".device-entry__meta") ?? undefined)).toEqual([
      "macOS 27.0",
      "Mac Studio",
    ]);
    expect(row.querySelector(".device-entry__facts")?.textContent).toContain("Mac15,14");
    expect(row.querySelector(".device-entry__facts")?.textContent).toContain("2026.8.1");
    expect(getSettingsRow(container, "Without stats").querySelector(".device-resource")).toBeNull();
  });

  it("hides only meters whose optional inputs are absent", () => {
    const container = renderDevicesContainer({
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
    const meters = getSettingsRow(container, "Memory only").querySelectorAll(".device-resource");
    expect(meters).toHaveLength(1);
    expect(meters[0]?.textContent).toContain("16 / 32 GB");
  });

  it.each(["gateway", "node:studio"])(
    "opens the recorded %s desktop environment in a focus window",
    async (environmentId) => {
      // Settings routes hide the docked panel, so the row must open the standalone window.
      vi.mocked(openDesktopFocus).mockClear();
      const container = renderDevicesContainer({
        basePath: "/ui",
        presence: [{ host: "This computer", mode: "gateway", ts: 1000 }],
        nodes: [{ nodeId: "studio", displayName: "Studio", paired: true, connected: true }],
        desktopEnvironments: [
          { id: environmentId, type: "host", status: "available", desktop: true },
        ],
      });
      expect(container.querySelectorAll(".device-entry__desktop")).toHaveLength(1);
      findButton(
        getSettingsRow(container, environmentId === "gateway" ? "This computer" : "Studio"),
        "Open desktop",
      ).click();
      expect(openDesktopFocus).toHaveBeenCalledExactlyOnceWith("/ui", environmentId);
    },
  );

  it("does not infer Desktop availability from commands", () => {
    const container = renderDevicesContainer({
      nodes: [
        { nodeId: "studio", displayName: "Studio", paired: true, commands: ["desktop.stream"] },
      ],
      desktopEnvironments: [
        { id: "node:studio", type: "node", status: "available", desktop: undefined },
        { id: "node:other", type: "node", status: "available", desktop: true },
      ],
    });
    const row = getSettingsRow(container, "Studio");
    expect(row.querySelector(".device-entry__desktop")).toBeNull();
    // Reads on a phone too, where a title would never show.
    expect(row.textContent).toContain("Desktop sharing");
    expect(row.textContent).toContain("pending desktop access request");
    expect(row.querySelector(".device-entry__facts")?.textContent).toContain("desktop.stream");
  });

  it("renders Gateway resources and uptime from system info", () => {
    const container = renderDevicesContainer({
      presence: [{ host: "This computer", mode: "gateway", ts: 1000 }],
      gatewaySystemInfo: {
        ...deviceSystemInfo,
        uptimeMs: (11 * 24 + 4) * 3600000,
        cpuCount: 16,
        loadAverage: [3.2, 2.8, 2.4],
        memoryTotalBytes: 64 * 1024 ** 3,
        memoryFreeBytes: 32 * 1024 ** 3,
        diskTotalBytes: 2 * 1024 ** 4,
        diskAvailableBytes: 1.2 * 1024 ** 4,
      },
    });
    const row = getSettingsRow(container, "This computer");
    expect(row.querySelectorAll(".device-resource")).toHaveLength(3);
    expect(row.querySelector(".device-resource--load")?.textContent).toContain("3.2");
    expect(row.textContent).toContain("1.2 TB free");
    expect(row.querySelector(".settings-row__desc")?.textContent).toContain("up 11d 4h");
  });

  it("keeps the paired-devices empty state when only other sections have rows", () => {
    const container = renderDevicesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-1",
            deviceId: "device-1",
            displayName: "Device One",
            role: "operator",
            scopes: [],
            ts: Date.now(),
          },
        ],
        paired: [],
      },
      presence: [{ instanceId: "probe-1", host: "laptop", mode: "probe", ts: 1_000 }],
    });

    const section = getInventorySection(container);
    expect(section.querySelector(".settings-empty")?.textContent).toContain(
      "No paired devices yet.",
    );
  });

  it("renders one row per machine with duplicates collapsed", () => {
    const container = renderDevicesContainer({
      devicesList: {
        pending: [],
        paired: [
          {
            deviceId: "mac-new",
            displayName: "MacBook",
            roles: ["operator", "node"],
            lastSeenAtMs: 3_000,
          },
          {
            deviceId: "mac-old",
            displayName: "MacBook",
            roles: ["operator", "node"],
            approvedVia: "silent",
            lastSeenAtMs: 1_000,
          },
        ],
      },
      nodes: [{ nodeId: "mac-new", displayName: "MacBook", connected: true, paired: true }],
    });
    const section = getInventorySection(container);

    const titles = Array.from(section.querySelectorAll(".settings-row__title")).map((title) =>
      title.textContent?.trim(),
    );
    expect(titles).toEqual(["MacBook", "MacBook"]);
    const dups = section.querySelector(
      "details.device-entry > .device-entry__body > .device-group__dups",
    );
    expect(dups?.textContent).toContain("1 older pairing");
    expect(dups?.textContent).toContain("mac-old");
    expect(findButton(section, "Clean up 1 stale")).toBeInstanceOf(HTMLButtonElement);
  });

  it("routes Remove through the existing inventory removal request", () => {
    const removed: InventoryRemovalRequest[] = [];
    const container = renderDevicesContainer({
      devicesList: {
        pending: [],
        paired: [
          {
            deviceId: "op-only",
            displayName: "Browser",
            roles: ["operator"],
          },
        ],
      },
      onInventoryRemove: (entry) => removed.push(entry),
    });

    const row = getSettingsRow(container, "Browser");
    expect(row.querySelector("summary [data-device-action]")).toBeNull();
    expect(action(row, "remove").classList.contains("danger")).toBe(true);
    action(row, "remove").click();

    expect(removed).toEqual([
      { id: "op-only", name: "Browser", removeNode: false, removeDevice: true },
    ]);
  });

  it("routes Edit alias to the device with its current alias", () => {
    const renamed: Array<{ id: string; name: string; operatorLabel?: string }> = [];
    const container = renderDevicesContainer({
      devicesList: {
        pending: [],
        paired: [
          {
            deviceId: "alias-device",
            displayName: "LIN-5F196050F5D",
            operatorLabel: "Office node",
            roles: ["operator"],
          },
          {
            deviceId: "unaliased-device",
            displayName: "Fresh laptop",
            roles: ["operator"],
          },
        ],
      },
      onDeviceRename: (device) => renamed.push(device),
    });

    action(getSettingsRow(container, "Office node"), "editAlias").click();
    action(getSettingsRow(container, "Fresh laptop"), "editAlias").click();

    expect(renamed).toEqual([
      { id: "alias-device", name: "Office node", operatorLabel: "Office node" },
      { id: "unaliased-device", name: "Fresh laptop", operatorLabel: undefined },
    ]);
  });

  it("keeps an open row and its focus when an inventory refresh adds a pending request", () => {
    const node = { nodeId: "node-one", displayName: "Node One", paired: true, connected: true };
    const props = createDevicesViewProps({ nodes: [node] });
    const container = renderDevicesContainer(props);
    const row = getSettingsRow(container, "Node One") as HTMLDetailsElement;
    row.open = true;
    const copy = expectDefined(
      row.querySelector<HTMLButtonElement>('button[aria-label="Copy device ID"]'),
      "Copy device ID button",
    );
    copy.focus();
    expect(document.activeElement).toBe(copy);

    renderDevicesInto(container, {
      ...props,
      nodes: [{ ...node, approvalState: "pending-reapproval", pendingRequestId: "request-new" }],
    });

    expect(getSection(container, "Pending approval").textContent).toContain("Node One");
    expect(getSettingsRow(getInventorySection(container), "Node One")).toBe(row);
    expect(row.open).toBe(true);
    expect(document.activeElement).toBe(copy);
  });

  it("retains warning badges and facts across fresh inventory snapshots", () => {
    const props = createDevicesViewProps({
      gatewayVersion: "2026.10.30",
      nodes: [
        {
          nodeId: "node-one",
          displayName: "Node One",
          paired: true,
          connected: false,
          platform: "win32",
          coreVersion: "2026.10.29",
          workerBundle: { status: "missing" },
        },
      ],
    });
    const container = renderDevicesContainer(props);
    const row = getSettingsRow(container, "Node One");
    const badges = Array.from(row.querySelectorAll(".device-entry__alerts > span"));
    const facts = Array.from(row.querySelectorAll(".device-entry__facts > .device-fact")).slice(
      0,
      3,
    );
    expect(badges).toHaveLength(3);
    expect(facts).toHaveLength(3);

    renderDevicesInto(container, { ...props, nodes: props.nodes.map((node) => ({ ...node })) });

    expect(
      Array.from(row.querySelectorAll(".device-entry__alerts > span")).every(
        (badge, index) => badge === badges[index],
      ),
    ).toBe(true);
    expect(
      Array.from(row.querySelectorAll(".device-entry__facts > .device-fact"))
        .slice(0, 3)
        .every((fact, index) => fact === facts[index]),
    ).toBe(true);
    renderDevicesInto(container, { ...props, gatewayVersion: "2026.11.1" });
    expect(row.querySelector(".device-entry__alerts > span")).toBe(badges[0]);
    expect(badges[0].getAttribute("title")).toContain("2026.11.1");
    expect(facts[0].textContent).toContain("2026.11.1");
    renderDevicesInto(container, { ...props, gatewayVersion: "2026.10.29" });
    const remaining = Array.from(row.querySelectorAll(".device-entry__alerts > span"));
    expect(remaining).toHaveLength(2);
    expect(remaining.every((badge, index) => badge === badges[index + 1])).toBe(true);
    expect(badges[0].isConnected).toBe(false);
  });

  it.each([true, false])(
    "reports the device ID copy outcome on the button when clipboard succeeds: %s",
    async (succeeds) => {
      const writeText = succeeds
        ? vi.fn().mockResolvedValue(undefined)
        : vi.fn().mockRejectedValue(new Error("Denied"));
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const container = renderDevicesContainer({
        canManagePairing: false,
        devicesList: {
          pending: [],
          paired: [{ deviceId: "copy-device-id", displayName: "Copy device", roles: ["operator"] }],
        },
      });
      const copy = expectDefined(
        getSettingsRow(container, "Copy device").querySelector<HTMLButtonElement>(
          'button[aria-label="Copy device ID"]',
        ),
        "Copy device ID button",
      );
      expect(copy.disabled).toBe(false);
      copy.click();
      await vi.waitFor(() => expect(copy.dataset.copyState).toBe(succeeds ? "copied" : "error"));
      expect(writeText).toHaveBeenCalledExactlyOnceWith("copy-device-id");
    },
  );

  it("keeps installed workers quiet and warns when the retained bundle is missing", () => {
    const container = renderDevicesContainer({
      nodes: [
        {
          nodeId: "node-installed",
          displayName: "Installed Mac",
          connected: true,
          paired: true,
          workerSlots: { total: 2, available: 1 },
          workerBundle: { status: "installed", version: "2026.8.9" },
        },
        {
          nodeId: "node-missing",
          displayName: "Missing Mac",
          connected: true,
          paired: true,
          workerBundle: { status: "missing" },
        },
      ],
    });
    const section = getInventorySection(container);
    const rows = Array.from(section.querySelectorAll(".device-entry"));
    const installed = rows.find((row) => row.textContent?.includes("Installed Mac"));
    const missing = rows.find((row) => row.textContent?.includes("Missing Mac"));

    expect(installed?.querySelector(".device-entry__facts")?.textContent).toContain(
      "Device software 2026.8.9",
    );
    expect(installed?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "1 of 2 slots busy",
    );
    expect(
      installed?.querySelector("summary .device-entry__meta")?.textContent ?? "",
    ).not.toContain("Device software");
    expect(installed ? statusesByText(installed, "Connected") : []).toHaveLength(1);
    expect(installed ? statusesByText(installed, "Device software missing") : []).toHaveLength(0);
    expect(missing ? statusesByText(missing, "Device software missing") : []).toHaveLength(1);
    const missingDetail =
      "Required device software is missing. Start a new session on this device to reinstall it.";
    expect(
      Array.from(missing?.querySelectorAll<HTMLElement>("[title]") ?? [])
        .find((element) => element.textContent?.trim() === "Device software missing")
        ?.getAttribute("title"),
    ).toBe(missingDetail);
    // A title never shows on a phone, so the open row says it too.
    expect(missing?.querySelector(".device-entry__facts")?.textContent).toContain(missingDetail);
  });

  it("shows device and Gateway version drift", () => {
    const container = renderDevicesContainer({
      gatewayVersion: "2026.7.2",
      basePath: "",
      nodes: [
        {
          nodeId: "node-old",
          displayName: "Older Mac",
          version: "19.4",
          coreVersion: "2026.6.11",
          uiVersion: "19.4",
          connected: true,
          paired: true,
        },
        {
          nodeId: "node-current",
          displayName: "Current Mac",
          version: "19.5",
          coreVersion: "2026.7.2",
          uiVersion: "19.5",
          connected: true,
          paired: true,
        },
        {
          nodeId: "node-newer",
          displayName: "Newer Mac",
          version: "19.6",
          coreVersion: "2026.8.1",
          uiVersion: "19.6",
          connected: true,
          paired: true,
        },
        {
          nodeId: "legacy-linux",
          displayName: "Legacy Linux",
          platform: "linux",
          version: "2026.6.10",
          connected: true,
          paired: true,
        },
      ],
    });
    const driftStatuses = Array.from(
      getInventorySection(container).querySelectorAll<HTMLElement>("[title]"),
    ).filter((element) => element.textContent?.trim() === "Version drift");

    expect(driftStatuses).toHaveLength(3);
    expect(
      driftStatuses
        .map((status) => status.getAttribute("title"))
        .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual([
      "Device 2026.6.10; Gateway 2026.7.2. Update the older version to match.",
      "Device 2026.6.11; Gateway 2026.7.2. Update the older version to match.",
      "Device 2026.8.1; Gateway 2026.7.2. Update the older version to match.",
    ]);
  });

  it("shows node-only offline affordances while preserving mixed-role device liveness", () => {
    const container = renderDevicesContainer({
      devicesList: {
        pending: [],
        paired: [
          {
            deviceId: "windows-mixed",
            displayName: "Mixed-role Windows",
            platform: "Windows 11",
            roles: ["operator", "node"],
            connected: true,
          },
        ],
      },
      nodes: [
        {
          nodeId: "windows-mixed",
          displayName: "Mixed-role Windows",
          platform: "Windows 11",
          connected: false,
          paired: true,
          workerSlots: { total: 8, available: 0 },
          hostStats: createOfflineDeviceNode().hostStats,
        },
      ],
    });
    const section = getInventorySection(container);
    const row = getSettingsRow(section, "Mixed-role Windows");

    expect(row.querySelector(".capacity-meter-pips")?.getAttribute("aria-label")).toBe(
      "Couldn’t load device capacity. Try again.",
    );
    expect(row.querySelectorAll(".device-resource .session-context-meter--stale")).toHaveLength(3);
    // Stale numbers say so once, and never count as live pressure on the closed row.
    expect(row.querySelectorAll(".device-resource__note")).toHaveLength(1);
    expect(row.querySelector(".device-resource__note")?.textContent).toContain("27d ago");
    expect(row.querySelectorAll(".capacity-meter-pips__pip--filled")).toHaveLength(0);
    expect(
      Array.from(row.querySelectorAll(".settings-status"), (status) => status.textContent?.trim()),
    ).toEqual(["Manual wake required", "Disconnected"]);
  });

  it("preserves the slot-less exec affordance through node inventory", () => {
    const container = renderDevicesContainer({
      nodes: [
        {
          nodeId: "exec",
          displayName: "Exec host",
          connected: true,
          paired: true,
          caps: ["codex.exec-server"],
          commands: [],
        },
      ],
    });
    const row = getSettingsRow(getInventorySection(container), "Exec host");
    expect(row.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Codex exec");
    expect(row.querySelector(".capacity-meter-pips, .session-context-meter")).toBeNull();
  });

  it("shows token rows with rotate and revoke inside the open row", () => {
    const rotations: Array<{ deviceId: string; name: string; role: string }> = [];
    const revocations: Array<{ deviceId: string; role: string }> = [];
    const container = renderDevicesContainer({
      devicesList: {
        pending: [],
        paired: [
          {
            deviceId: "device-1",
            displayName: "Device One",
            roles: ["operator"],
            scopes: ["operator.read"],
            tokens: [
              { role: "operator", scopes: ["operator.read"], createdAtMs: Date.now() },
              { role: "node", scopes: [], createdAtMs: Date.now(), revokedAtMs: Date.now() },
            ],
          },
        ],
      },
      onDeviceRotate: (device, role) =>
        rotations.push({ deviceId: device.id, name: device.name, role }),
      onDeviceRevoke: (deviceId, role) => revocations.push({ deviceId, role }),
    });
    const section = getInventorySection(container);

    const facts = expectDefined(section.querySelector(".device-entry__facts"), "device facts");
    expect(facts.querySelector("dd[title='device-1']")?.textContent).toContain("device-1");
    // Tokens carry their role and scopes, so neither repeats as its own fact.
    expect(Array.from(facts.querySelectorAll("dt"), (label) => label.textContent)).not.toContain(
      "Scopes",
    );
    const [active, revoked] = Array.from(facts.querySelectorAll(".device-token"));
    expect(active?.querySelector(".device-token__role")?.textContent).toBe("Access token");
    expect(active?.querySelector("details")?.textContent).toContain("operator.read");
    expect(active?.textContent).not.toContain("Revoked");
    expect(
      revoked?.querySelector(".device-token__text > .device-entry__meta")?.textContent,
    ).toContain("Revoked");
    expect(revoked?.querySelector(".device-token__role")?.textContent).toBe("Device token");
    expect(revoked?.querySelector("details")?.open).toBe(false);
    expect(revoked?.querySelector("details")?.textContent).toContain("node");
    expect(revoked?.querySelectorAll("button")).toHaveLength(1);
    findButton(section, "Rotate").click();
    // The rotate callback carries the row label, so the outcome dialog can name it.
    expect(rotations).toEqual([{ deviceId: "device-1", name: "Device One", role: "operator" }]);
    findButton(section, "Revoke").click();
    expect(revocations).toEqual([{ deviceId: "device-1", role: "operator" }]);
  });

  it("keeps roles and scopes no token carries", () => {
    const container = renderDevicesContainer({
      devicesList: {
        pending: [],
        paired: [
          {
            deviceId: "device-1",
            displayName: "Device One",
            roles: ["operator"],
            scopes: ["operator.read"],
          },
        ],
      },
    });
    const facts = Array.from(
      getSettingsRow(container, "Device One").querySelectorAll("dt"),
      (label) => label.textContent,
    );
    expect(facts).toContain("Roles");
    expect(facts).toContain("Scopes");
  });

  it("brands platform names instead of naive capitalization", () => {
    const container = renderDevicesContainer({
      devicesList: {
        pending: [],
        paired: [
          { deviceId: "ios-1", displayName: "iPhone", platform: "iOS 26.4", roles: ["operator"] },
          { deviceId: "mac-1", displayName: "Mac", platform: "darwin", roles: ["operator"] },
          {
            deviceId: "mac-browser",
            displayName: "Mac browser",
            platform: "MacIntel",
            deviceFamily: "Mac",
            roles: ["operator"],
          },
          {
            deviceId: "ipad-browser",
            displayName: "iPad browser",
            platform: "MacIntel",
            deviceFamily: "iPad",
            roles: ["operator"],
          },
          {
            deviceId: "legacy-browser",
            displayName: "Legacy browser",
            platform: "MacIntel",
            roles: ["operator"],
          },
        ],
      },
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
    const subs = Array.from(
      getInventorySection(container).querySelectorAll(".device-entry .settings-row__desc"),
      (node) => node.textContent ?? "",
    );

    expect(subs.some((text) => text.includes("iOS 26.4"))).toBe(true);
    expect(subs.some((text) => text.includes("IOS"))).toBe(false);
    expect(subs.some((text) => text.includes("macOS"))).toBe(true);
    for (const [name, label] of [
      ["Mac browser", "macOS"],
      ["iPad browser", "iPadOS"],
      ["Legacy browser", "MacIntel"],
      ["Unpaired iPad", "iPadOS"],
    ]) {
      const row = Array.from(container.querySelectorAll(".device-entry")).find(
        (entry) => entry.querySelector(".settings-row__title")?.textContent === name,
      );
      expect(metaParts(row)[0]).toBe(label);
    }
  });

  it("announces device and node list errors as alerts", () => {
    const container = renderDevicesContainer({
      devicesError: "Device list unavailable",
      lastError: "Node list unavailable",
    });

    expect(
      Array.from(container.querySelectorAll('[role="alert"]'), (alert) => alert.textContent),
    ).toEqual(["Device list unavailable", "Node list unavailable"]);
  });
});

describe("devices access gating", () => {
  it("disables pairing and admin mutations with one browsing-only notice", () => {
    const onInventoryRemove = vi.fn();
    const onNodeApprove = vi.fn();
    const onNodeReject = vi.fn();
    const onDeviceRename = vi.fn();
    const container = renderDevicesContainer({
      onInventoryRemove,
      onNodeApprove,
      onNodeReject,
      onDeviceRename,
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
      devicesList: {
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
          {
            deviceId: "device-1",
            displayName: "Device One",
            roles: ["operator"],
            tokens: [{ role: "operator", scopes: ["operator.read"], createdAtMs: Date.now() }],
          },
        ],
      },
      configForm: { agents: { entries: { main: {} } } },
    });

    expect(container.querySelectorAll(".callout.info")).toHaveLength(1);
    expect(container.textContent).toContain("only admins can change them");
    for (const label of ["Approve", "Reject", "Rotate", "Revoke"]) {
      expect(findButton(container, label).disabled).toBe(true);
    }
    const row = getSettingsRow(container, "Device One");
    for (const name of ["remove", "editAlias"]) {
      expect(action(row, name).disabled).toBe(true);
      expect(action(row, name).title).toContain("only admins");
      action(row, name).click();
    }
    const pendingNode = getSettingsRow(getSection(container, "Pending approval"), "Pending node");
    for (const name of ["approve", "reject"]) {
      expect(action(pendingNode, name).disabled).toBe(true);
      action(pendingNode, name).click();
    }
    expect(onInventoryRemove).not.toHaveBeenCalled();
    expect(onDeviceRename).not.toHaveBeenCalled();
    expect(onNodeApprove).not.toHaveBeenCalled();
    expect(onNodeReject).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Command approvals");
  });
});
