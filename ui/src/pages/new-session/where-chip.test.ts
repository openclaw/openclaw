/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { deviceIcons } from "../../components/icons-devices.ts";
import { icons } from "../../components/icons.ts";
import { readDraftCloudProfiles } from "./discovery.ts";
import { renderWhereChip, resolveWhereChip } from "./where-chip.ts";

function renderPicker(
  isAdmin: boolean,
  autoPlacementMode?: "least-busy" | "eligible-order",
  selection: Partial<Parameters<typeof resolveWhereChip>[0]> = {},
  presentation: Partial<Parameters<typeof renderWhereChip>[0]> = {},
) {
  const state = resolveWhereChip({
    environments: [
      {
        id: "node:runner",
        type: "node",
        label: "Build runner",
        status: "available",
        sessionHost: true,
        workerSlots: { total: 2, available: 1 },
      },
      {
        id: "node:alpha-device",
        type: "node",
        label: "Duplicate runner",
        status: "available",
        sessionHost: true,
        workerSlots: { total: 1, available: 1 },
      },
      {
        id: "node:beta-device",
        type: "node",
        label: "Duplicate runner",
        status: "available",
        sessionHost: true,
        workerSlots: { total: 1, available: 1 },
      },
    ],
    cloudProfiles: [{ id: "aws", providerId: "crabbox" }],
    cloudProfileId: "",
    deviceId: "",
    ...selection,
  });
  const container = document.createElement("div");
  render(
    renderWhereChip({
      state,
      gatewayName: "",
      environmentQuery: "",
      onEnvironmentQueryInput: vi.fn(),
      cloudProfileId: selection.cloudProfileId ?? "",
      deviceId: selection.deviceId ?? "",
      autoDevice: selection.autoDevice,
      worktreeAvailable: true,
      submitting: false,
      pendingPlacement: false,
      popoverOpen: true,
      popoverHiding: false,
      isAdmin,
      ...(autoPlacementMode ? { autoPlacementMode } : {}),
      onGuardTransition: vi.fn(),
      onPopoverShow: vi.fn(),
      onPopoverHide: vi.fn(),
      onPopoverAfterHide: vi.fn(),
      onSelectDevice: vi.fn(),
      onToggleAutoDevice: vi.fn(),
      onSelectCloudProfile: vi.fn(),
      onConnectMachine: vi.fn(),
      ...presentation,
    }),
    container,
  );
  return container;
}

describe("Where chip", () => {
  it.each([
    { label: "Work MacBook Pro", platform: "darwin", icon: deviceIcons.laptop, form: "laptop" },
    {
      label: "Personal MacBook Air",
      platform: undefined,
      icon: deviceIcons.laptop,
      form: "laptop",
    },
    { label: "Office Mac-mini", platform: "darwin", icon: deviceIcons.macMini, form: "mini" },
    { label: "Build Mac Studio", platform: "macOS", icon: deviceIcons.macStudio, form: "studio" },
    { label: "Development workstation", platform: "darwin", icon: icons.monitor, form: null },
    { label: "MacBookish workstation", platform: "darwin", icon: icons.monitor, form: null },
    { label: "Studio runner", platform: "darwin", icon: icons.monitor, form: null },
    { label: "Build Mac Studio", platform: "linux", icon: icons.monitor, form: null },
  ])(
    "uses the same device outline in the selected row and trigger: $label / $platform",
    ({ label, platform, icon, form }) => {
      const container = renderPicker(true, undefined, {
        deviceId: "model-device",
        environments: [
          {
            id: "node:model-device",
            type: "node",
            label,
            platform,
            status: "available",
            sessionHost: true,
            workerSlots: { total: 2, available: 1 },
          },
        ],
      });
      const expected = document.createElement("div");
      render(icon, expected);
      const expectedSvg = expected.querySelector("svg")!;

      expect(
        expectedSvg.isEqualNode(
          container.querySelector('[data-value="device:model-device"] .session-menu__icon svg'),
        ),
      ).toBe(true);
      expect(
        expectedSvg.isEqualNode(
          container.querySelector("#new-session-where-trigger .new-session-page__target-icon svg"),
        ),
      ).toBe(true);
      for (const selector of [
        '[data-value="device:model-device"] .session-menu__icon',
        "#new-session-where-trigger .new-session-page__target-icon",
      ]) {
        const marker = container.querySelector(`${selector} .new-session-page__device-icon`);
        if (form) {
          expect(marker?.getAttribute("data-form")).toBe(form);
        } else {
          expect(marker).toBeNull();
        }
      }
    },
  );

  it.each([
    { cloudProfileId: "", value: "gateway", icon: icons.home },
    { cloudProfileId: "aws", value: "cloud:aws", icon: icons.cloud },
  ])(
    "keeps destination-type icons for $value even with a Mac-named Gateway",
    ({ cloudProfileId, value, icon }) => {
      const container = renderPicker(
        true,
        undefined,
        { cloudProfileId },
        { gatewayName: "Gateway Mac Studio" },
      );
      const expected = document.createElement("div");
      render(icon, expected);
      const expectedSvg = expected.querySelector("svg")!;

      expect(
        expectedSvg.isEqualNode(
          container.querySelector(`[data-value="${value}"] .session-menu__icon svg`),
        ),
      ).toBe(true);
      expect(
        expectedSvg.isEqualNode(
          container.querySelector("#new-session-where-trigger .new-session-page__target-icon svg"),
        ),
      ).toBe(true);
      expect(
        container.querySelector(`[data-value="${value}"] .new-session-page__device-icon`),
      ).toBeNull();
      expect(
        container.querySelector("#new-session-where-trigger .new-session-page__device-icon"),
      ).toBeNull();
    },
  );

  it.each([
    { query: "  local  ", expected: ["gateway"] },
    { query: "STUDIO", expected: ["gateway"] },
    { query: "device", expected: ["device:runner", "device:alpha-device", "device:beta-device"] },
    { query: "beta-device", expected: ["device:beta-device"] },
    { query: "cloud", expected: ["cloud:aws"] },
    { query: "AWS", expected: ["cloud:aws"] },
    { query: "crabbox", expected: ["cloud:aws"] },
    { query: "persistent", expected: ["cloud:aws"] },
  ])("searches destination names, types, IDs and facts: $query", ({ query, expected }) => {
    const container = renderPicker(
      true,
      undefined,
      { cloudProfiles: [{ id: "aws", providerId: "crabbox", trust: "persistent" }] },
      { gatewayName: "Build Studio", environmentQuery: query },
    );

    expect(
      [...container.querySelectorAll(".new-session-page__environment-list [data-value]")].map(
        (row) => row.getAttribute("data-value"),
      ),
    ).toEqual(expected);
  });

  it("keeps matching Local, Devices and Cloud in order with device facts searchable", () => {
    const container = renderPicker(
      true,
      undefined,
      {
        environments: [
          {
            id: "node:zulu",
            type: "node",
            label: "Zulu runner",
            platform: "linux",
            status: "available",
            sessionHost: true,
            workerSlots: { total: 2, available: 1 },
          },
          {
            id: "node:alpha",
            type: "node",
            label: "Alpha runner",
            platform: "linux",
            status: "available",
            sessionHost: true,
            workerSlots: { total: 2, available: 1 },
          },
        ],
        cloudProfiles: [{ id: "linux-worker", providerId: "crabbox" }],
      },
      { gatewayName: "Linux Studio", environmentQuery: "LINUX" },
    );

    expect(
      [...container.querySelectorAll(".new-session-page__environment-list [data-value]")].map(
        (row) => row.getAttribute("data-value"),
      ),
    ).toEqual(["gateway", "device:alpha", "device:zulu", "cloud:linux-worker"]);
    expect(container.querySelector('[data-value="device:alpha"]')?.textContent).toContain("Linux");
  });

  it("keeps Auto and Connect outside search results and reports an empty search", () => {
    const container = renderPicker(true, undefined, {}, { environmentQuery: "no-such-runner" });
    const results = container.querySelector(".new-session-page__environment-list");

    expect(results?.querySelectorAll("[data-value]")).toHaveLength(0);
    expect(results?.textContent).toContain("No matching environments");
    for (const value of ["auto-device", "connect-machine"]) {
      const action = container.querySelector<HTMLButtonElement>(`[data-value="${value}"]`);
      expect(action).not.toBeNull();
      expect(action?.disabled).toBe(false);
      expect(results?.contains(action)).toBe(false);
    }
  });

  it("forwards search input without changing the selected destination", () => {
    const onEnvironmentQueryInput = vi.fn();
    const onSelectDevice = vi.fn();
    const container = renderPicker(
      true,
      undefined,
      { deviceId: "runner" },
      { onEnvironmentQueryInput, onSelectDevice },
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search environments"]',
    )!;

    input.value = "cloud";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onEnvironmentQueryInput).toHaveBeenCalledExactlyOnceWith("cloud");
    expect(onSelectDevice).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-value="device:runner"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keeps slot indicators and reserves the checkmark column when selecting a device", () => {
    const container = renderPicker(true, undefined, { deviceId: "runner" });
    const selected = container.querySelector('[data-value="device:runner"]');
    const unselected = container.querySelector('[data-value="device:alpha-device"]');

    expect(selected?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "1 of 2 slots busy",
    );
    expect(selected?.querySelector(".session-menu__check svg")).not.toBeNull();
    expect(unselected?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "0 of 1 slots busy",
    );
    expect(unselected?.querySelector(".session-menu__check")).not.toBeNull();
    expect(unselected?.querySelector(".session-menu__check svg")).toBeNull();
  });

  it.each([false, true])("toggles automatic placement from %s", (autoDevice) => {
    const onSelectDevice = vi.fn();
    const onToggleAutoDevice = vi.fn();
    const container = renderPicker(
      true,
      undefined,
      { autoDevice },
      { onSelectDevice, onToggleAutoDevice },
    );
    const automatic = container.querySelector<HTMLButtonElement>('[data-value="auto-device"]')!;

    expect(automatic.getAttribute("role")).toBe("switch");
    expect(automatic.getAttribute("aria-checked")).toBe(String(autoDevice));
    expect(automatic.textContent).toContain("Connected devices only");
    automatic.click();

    expect(onToggleAutoDevice).toHaveBeenCalledExactlyOnceWith(!autoDevice);
    expect(onSelectDevice).not.toHaveBeenCalled();
  });

  it("requires turning off Auto before choosing a destination without locking search or Connect", () => {
    const onSelectDevice = vi.fn();
    const onSelectCloudProfile = vi.fn();
    const onEnvironmentQueryInput = vi.fn();
    const onConnectMachine = vi.fn();
    const container = renderPicker(
      true,
      undefined,
      { autoDevice: true },
      { onSelectDevice, onSelectCloudProfile, onEnvironmentQueryInput, onConnectMachine },
    );
    const destinations = container.querySelectorAll<HTMLButtonElement>(
      ".new-session-page__environment-list [data-value]",
    );

    expect(destinations).toHaveLength(5);
    for (const destination of destinations) {
      expect(destination.disabled).toBe(true);
      destination.click();
    }
    expect(onSelectDevice).not.toHaveBeenCalled();
    expect(onSelectCloudProfile).not.toHaveBeenCalled();

    const meter = container.querySelector('[data-value="device:runner"] [role="img"]');
    expect(meter?.getAttribute("aria-label")).toBe("1 of 2 slots busy");
    expect(meter?.classList.contains("session-context-meter--stale")).toBe(false);

    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(search.disabled).toBe(false);
    search.value = "cloud";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onEnvironmentQueryInput).toHaveBeenCalledExactlyOnceWith("cloud");

    const connect = container.querySelector<HTMLButtonElement>('[data-value="connect-machine"]')!;
    expect(connect.disabled).toBe(false);
    connect.click();
    expect(onConnectMachine).toHaveBeenCalledOnce();
  });

  it.each([true, false])("preserves destination eligibility with Auto set to %s", (autoDevice) => {
    const container = renderPicker(
      true,
      undefined,
      {
        autoDevice,
        environments: [
          {
            id: "node:ready",
            type: "node",
            label: "Ready runner",
            status: "available",
            sessionHost: true,
            workerSlots: { total: 2, available: 1 },
          },
          {
            id: "node:offline",
            type: "node",
            label: "Offline runner",
            status: "unavailable",
            sessionHost: true,
            workerSlots: { total: 2, available: 1 },
          },
        ],
        cloudProfiles: [
          { id: "aws", providerId: "crabbox" },
          { id: "blocked", providerId: "static-ssh" },
        ],
      },
      {
        cloudProfileDisabledReason: (profile) =>
          profile.id === "blocked" ? "Runtime unavailable" : undefined,
      },
    );

    for (const value of ["gateway", "device:ready", "cloud:aws"]) {
      expect(container.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)?.disabled).toBe(
        autoDevice,
      );
    }
    for (const value of ["device:offline", "cloud:blocked"]) {
      expect(container.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)?.disabled).toBe(
        true,
      );
    }
    expect(container.querySelector('[data-value="gateway"]')?.getAttribute("aria-pressed")).toBe(
      String(!autoDevice),
    );
  });

  it.each([
    { submitting: false, pendingPlacement: false, disabled: false },
    { submitting: true, pendingPlacement: false, disabled: true },
    { submitting: false, pendingPlacement: true, disabled: true },
  ])("allows turning off Auto without devices except during submission: %j", (presentation) => {
    const onToggleAutoDevice = vi.fn();
    const container = renderPicker(
      true,
      undefined,
      { environments: [], autoDevice: true },
      { ...presentation, onToggleAutoDevice },
    );
    const automatic = container.querySelector<HTMLButtonElement>('[data-value="auto-device"]')!;

    expect(automatic.disabled).toBe(presentation.disabled);
    automatic.click();
    if (presentation.disabled) {
      expect(onToggleAutoDevice).not.toHaveBeenCalled();
    } else {
      expect(onToggleAutoDevice).toHaveBeenCalledExactlyOnceWith(false);
    }
  });

  it("keeps unavailable operating systems visible with the provider's repair hint", () => {
    const reason = "Upgrade Crabbox to 0.53.1 or newer, then restart the Gateway.";
    const container = renderPicker(true, undefined, {
      cloudProfileId: "aws",
      cloudProfiles: readDraftCloudProfiles([
        {
          id: "aws",
          providerId: "crabbox",
          operatingSystems: [
            { id: "linux", label: "Linux", default: true },
            { id: "macos", label: "macOS", disabledReason: reason },
            { id: "windows/wsl2", label: "Windows (WSL2)", disabledReason: reason },
          ],
        },
      ]),
    });
    expect(container.querySelector<HTMLButtonElement>('[data-value="os:linux"]')?.disabled).toBe(
      false,
    );
    for (const os of ["macos", "windows/wsl2"]) {
      const row = container.querySelector<HTMLButtonElement>(`[data-value="os:${os}"]`);
      expect(row?.disabled).toBe(true);
      expect(row?.textContent).toContain(reason);
    }
  });

  it.each([
    { os: undefined, machineClass: undefined, label: "aws", machine: "Tiny Linux" },
    { os: "linux", machineClass: "tiny", label: "aws · Tiny Linux", machine: "Tiny Linux" },
    {
      os: "windows/wsl2",
      machineClass: undefined,
      label: "aws · Windows (WSL2)",
      machine: "Tiny Windows",
    },
    {
      os: "windows/wsl2",
      machineClass: "tiny",
      label: "aws · Windows (WSL2) · Tiny Windows",
      machine: "Tiny Windows",
    },
  ])(
    "keeps OS and class choices for $label during environment search",
    ({ os, machineClass, label, machine }) => {
      const container = renderPicker(
        true,
        undefined,
        {
          cloudProfileId: "aws",
          os,
          machineClass,
          cloudProfiles: [
            {
              id: "aws",
              providerId: "crabbox",
              operatingSystems: [
                { id: "linux", label: "Linux", default: true },
                { id: "windows/wsl2", label: "Windows (WSL2)" },
              ],
              machines: [
                { id: "tiny", label: "Tiny Linux", os: "linux", default: true },
                { id: "tiny", label: "Tiny Windows", os: "windows/wsl2", default: true },
                { id: "custom", label: "Custom" },
              ],
            },
          ],
        },
        { environmentQuery: "unmatched-environment" },
      );
      expect(container.querySelector('[data-value="cloud:aws"]')).toBeNull();
      expect(container.querySelector(".new-session-page__trigger-label")?.textContent).toBe(label);
      expect(container.querySelectorAll('[data-value="machine:tiny"]')).toHaveLength(1);
      expect(container.querySelector('[data-value="machine:tiny"]')?.textContent).toContain(
        machine,
      );
      expect(container.querySelector('[data-value="machine:custom"]')).not.toBeNull();
      const osRow = container.querySelector('[data-value="os:linux"]');
      expect(osRow?.textContent).toContain("Default");
      expect(osRow?.hasAttribute("data-popover")).toBe(false);
      expect(
        osRow?.compareDocumentPosition(container.querySelector('[data-value="machine:tiny"]')!),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    },
  );

  it("keeps capacity structured and exposes busy slots without an ambiguous visible fraction", () => {
    const state = resolveWhereChip({
      environments: [
        {
          id: "node:runner",
          type: "node",
          label: "Build runner",
          status: "available",
          sessionHost: true,
          workerSlots: { total: 2, available: 1 },
        },
      ],
      cloudProfiles: [],
      cloudProfileId: "",
      deviceId: "runner",
    });

    expect(state.kind).toBe("device");
    expect(state.label).toBe("Build runner");
    const row = renderPicker(false).querySelector('[data-value="device:runner"]');
    expect(row?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "1 of 2 slots busy",
    );
    expect(row?.getAttribute("title")).toBe("1 of 2 slots busy");
    expect(row?.textContent).not.toContain("Worker slots");
    expect(state.devices[0]?.workerSlots).toEqual({ total: 2, available: 1 });
    expect(state.devices[0]?.facts).toEqual([]);
  });

  it("renders devices for writers while cloud and Connect remain admin-only", () => {
    const writer = renderPicker(false);
    const autoRow = writer.querySelector('[data-value="auto-device"]');
    expect(autoRow?.textContent).toContain("Choose a device automatically");
    expect(autoRow?.getAttribute("role")).toBe("switch");
    expect(autoRow?.getAttribute("aria-checked")).toBe("false");
    expect(autoRow?.querySelector(".session-menu__description")?.textContent).toContain(
      "Least-busy device",
    );
    const remoteExec = renderPicker(false, "eligible-order");
    expect(
      remoteExec.querySelector('[data-value="auto-device"] .session-menu__description')
        ?.textContent,
    ).toContain("First eligible device");
    expect(writer.querySelector('[data-value="device:runner"]')).not.toBeNull();
    expect(writer.querySelector('[data-value="device:runner"] .session-menu__sub')).toBeNull();
    expect(
      writer.querySelector('[data-value="device:alpha-device"] .session-menu__description')
        ?.textContent,
    ).toContain("alpha-de");
    expect(
      writer.querySelector('[data-value="device:beta-device"] .session-menu__description')
        ?.textContent,
    ).toContain("beta-dev");
    expect(writer.querySelector('[data-value="cloud:aws"]')).toBeNull();
    expect(writer.querySelector('[data-value="connect-machine"]')).toBeNull();

    const admin = renderPicker(true);
    expect(admin.querySelector('[data-value="device:runner"]')).not.toBeNull();
    expect(admin.querySelector('[data-value="cloud:aws"]')).not.toBeNull();
    expect(admin.querySelector('[data-value="connect-machine"]')).not.toBeNull();
  });

  it("disables device placements when the selected runtime cannot dispatch to devices", () => {
    const state = resolveWhereChip({
      environments: [
        {
          id: "node:macbook",
          type: "node",
          label: "MacBook",
          status: "available",
          sessionHost: true,
          workerSlots: { total: 1, available: 1 },
        },
      ],
      cloudProfiles: [],
      cloudProfileId: "",
      deviceId: "",
      deviceDisabledReason: "This runtime does not support paired devices",
    });
    const container = document.createElement("div");
    render(
      renderWhereChip({
        state,
        gatewayName: "",
        environmentQuery: "",
        onEnvironmentQueryInput: vi.fn(),
        cloudProfileId: "",
        deviceId: "",
        worktreeAvailable: true,
        submitting: false,
        pendingPlacement: false,
        popoverOpen: true,
        popoverHiding: false,
        isAdmin: true,
        onGuardTransition: () => undefined,
        onPopoverShow: () => undefined,
        onPopoverHide: () => undefined,
        onPopoverAfterHide: () => undefined,
        onSelectDevice: () => undefined,
        onToggleAutoDevice: () => undefined,
        onSelectCloudProfile: () => undefined,
        onConnectMachine: () => undefined,
      }),
      container,
    );

    const device = container.querySelector<HTMLButtonElement>('[data-value="device:macbook"]');
    expect(device?.disabled).toBe(true);
    expect(device?.textContent).toContain("This runtime does not support paired devices");
    // The disabled reason owns the title; the meter's no-claim alt text stays on its aria-label.
    expect(device?.title).toBe("This runtime does not support paired devices");
  });

  it("omits automatic placement when no devices are paired and Auto is off", () => {
    const state = resolveWhereChip({
      environments: [],
      cloudProfiles: [],
      cloudProfileId: "",
      deviceId: "",
    });
    const emptyContainer = document.createElement("div");
    render(
      renderWhereChip({
        state,
        gatewayName: "",
        environmentQuery: "",
        onEnvironmentQueryInput: vi.fn(),
        cloudProfileId: "",
        deviceId: "",
        worktreeAvailable: true,
        submitting: false,
        pendingPlacement: false,
        popoverOpen: true,
        popoverHiding: false,
        isAdmin: false,
        onGuardTransition: vi.fn(),
        onPopoverShow: vi.fn(),
        onPopoverHide: vi.fn(),
        onPopoverAfterHide: vi.fn(),
        onSelectDevice: vi.fn(),
        onToggleAutoDevice: vi.fn(),
        onSelectCloudProfile: vi.fn(),
        onConnectMachine: vi.fn(),
      }),
      emptyContainer,
    );
    expect(emptyContainer.querySelector('[data-value="auto-device"]')).toBeNull();
  });

  it.each([
    {
      name: "no paired device hosts sessions",
      issues: undefined,
      reason: /no session hosts are paired/i,
    },
    {
      name: "a paired node must be updated before it can advertise session hosting",
      issues: [
        {
          code: "update-required",
          action: "update-and-reconnect",
          updateCommand: "openclaw update",
          headlessReconnectCommand: "openclaw node restart",
        } as const,
      ],
      reason: /openclaw update.*openclaw node restart/i,
    },
  ])("disables automatic selection with an actionable reason when $name", ({ issues, reason }) => {
    const state = resolveWhereChip({
      environments: [
        {
          id: "node:macbook",
          type: "node",
          label: "MacBook",
          status: "available",
          sessionHost: false,
          ...(issues ? { issues } : {}),
        },
      ],
      cloudProfiles: [],
      cloudProfileId: "",
      deviceId: "",
    });
    const container = document.createElement("div");
    render(
      renderWhereChip({
        state,
        gatewayName: "",
        environmentQuery: "",
        onEnvironmentQueryInput: vi.fn(),
        cloudProfileId: "",
        deviceId: "",
        worktreeAvailable: true,
        submitting: false,
        pendingPlacement: false,
        popoverOpen: true,
        popoverHiding: false,
        isAdmin: false,
        onGuardTransition: vi.fn(),
        onPopoverShow: vi.fn(),
        onPopoverHide: vi.fn(),
        onPopoverAfterHide: vi.fn(),
        onSelectDevice: vi.fn(),
        onToggleAutoDevice: vi.fn(),
        onSelectCloudProfile: vi.fn(),
        onConnectMachine: vi.fn(),
      }),
      container,
    );

    const automatic = container.querySelector<HTMLButtonElement>('[data-value="auto-device"]');
    expect(automatic?.disabled).toBe(true);
    expect(automatic?.title).toMatch(reason);
    expect(automatic?.textContent).toMatch(reason);
  });

  it.each([
    {
      name: "allows enabled remote execution without a free worker slot",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      workerSlots: { total: 1, available: 0 },
      invocableCommands: ["codex.exec-server.stdio.v1"],
      commandState: "invocable" as const,
      disabled: false,
      label: "1 of 1 slots busy",
      tone: "warn",
    },
    {
      name: "shows slot-less remote execution without a capacity claim",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      workerSlots: undefined,
      invocableCommands: ["codex.exec-server.stdio.v1"],
      commandState: "invocable" as const,
      disabled: false,
      label: "Codex exec",
      tone: undefined,
    },
    {
      name: "keeps worker execution capacity-gated",
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
      workerSlots: { total: 1, available: 0 },
      invocableCommands: [],
      commandState: undefined,
      disabled: true,
      reason: "No worker slots are available. Wait for a slot or pick another device.",
      label: "Slot utilization unavailable",
      tone: "stale",
    },
    {
      name: "disables a declared remote command that the Gateway has not enabled",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      workerSlots: { total: 1, available: 1 },
      invocableCommands: [],
      commandState: "unauthorized" as const,
      disabled: true,
      reason:
        "Authorize codex.exec-server.stdio.v1 in the Gateway node command policy, or pick another device.",
      label: "Slot utilization unavailable",
      tone: "stale",
    },
  ])(
    "$name in the New Session picker",
    ({
      devicePlacement,
      workerSlots,
      invocableCommands,
      commandState,
      disabled,
      reason,
      label,
      tone,
    }) => {
      const state = resolveWhereChip({
        environments: [
          {
            id: "node:runner",
            type: "node",
            label: "Build runner",
            status: "available",
            sessionHost: true,
            workerSlots,
            capabilities: ["codex.exec-server.stdio.v1"],
            invocableCommands,
            ...(commandState
              ? {
                  requiredNodeCommand: {
                    command: "codex.exec-server.stdio.v1",
                    state: commandState,
                  },
                }
              : {}),
          },
        ],
        cloudProfiles: [],
        cloudProfileId: "",
        deviceId: "",
        devicePlacement,
      });
      const container = document.createElement("div");
      render(
        renderWhereChip({
          state,
          gatewayName: "",
          environmentQuery: "",
          onEnvironmentQueryInput: vi.fn(),
          cloudProfileId: "",
          deviceId: "",
          worktreeAvailable: true,
          submitting: false,
          pendingPlacement: false,
          popoverOpen: true,
          popoverHiding: false,
          isAdmin: true,
          onGuardTransition: vi.fn(),
          onPopoverShow: vi.fn(),
          onPopoverHide: vi.fn(),
          onPopoverAfterHide: vi.fn(),
          onSelectDevice: vi.fn(),
          onToggleAutoDevice: vi.fn(),
          onSelectCloudProfile: vi.fn(),
          onConnectMachine: vi.fn(),
        }),
        container,
      );

      const device = container.querySelector<HTMLButtonElement>('[data-value="device:runner"]');
      expect(device?.disabled).toBe(disabled);
      const meter = device?.querySelector('[role="img"]');
      expect(meter?.getAttribute("aria-label")).toBe(label);
      if (tone) {
        expect(meter?.classList.contains(`session-context-meter--${tone}`)).toBe(true);
      }
      if (reason) {
        expect(device?.title).toBe(reason);
      }
    },
  );
});
