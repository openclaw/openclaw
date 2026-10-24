/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeListNode } from "../../../../src/shared/node-list-types.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { i18n } from "../../i18n/index.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { pairedCompanionApps } from "./updates-apps.tsx";
import {
  createUpdatesViewDom,
  createUpdatesViewProps,
  nativeSettings,
} from "./updates.test-support.ts";

const app = (nodeId: string, extra: Partial<NodeListNode> = {}): NodeListNode => ({
  nodeId,
  displayName: nodeId,
  paired: true,
  connected: true,
  clientId: "openclaw-ios",
  clientMode: "node",
  platform: "ios",
  version: "2026.10.1",
  ...extra,
});
beforeEach(async () => {
  await i18n.setLocale("en");
});
function openApps(view: ReturnType<typeof createUpdatesViewDom>) {
  view.container.querySelector<HTMLButtonElement>("#updates-apps-tab")!.click();
  flush();
}
function select(view: ReturnType<typeof createUpdatesViewDom>, value: string) {
  const input = view.container.querySelector<HTMLSelectElement>('select[aria-label="System"]')!;
  input.value = value;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  flush();
}

describe("companion app inventory", () => {
  it("includes only paired approved native node clients and preserves separate installations", () => {
    const nodes = [
      app("offline", { connected: false }),
      app("local"),
      app("second"),
      app("pending", { paired: false }),
      app("unapproved", { approvalState: "pending-reapproval" }),
      app("ui", { clientMode: "ui" }),
      app("worker", { clientId: "openclaw-worker" }),
      app("browser", { clientId: "openclaw-control-ui" }),
      app("host", { clientId: "node-host" }),
      app("unknown", { clientId: undefined }),
      app("watch", { clientId: "openclaw-watchos" }),
    ];
    expect(pairedCompanionApps(nodes, "local").map((node) => node.nodeId)).toEqual([
      "second",
      "watch",
      "offline",
    ]);
    expect(pairedCompanionApps(nodes).map((node) => node.nodeId)).toContain("local");
  });

  it("shows browser inventory with offline status, reported version only and no update action", async () => {
    const view = createUpdatesViewDom();
    const request = vi.fn().mockResolvedValue({
      nodes: [
        app("Phone"),
        app("Tablet", {
          connected: false,
          version: undefined,
          coreVersion: "not-app",
          uiVersion: "not-app-either",
        }),
      ],
    });
    view.mountUpdates(createUpdatesViewProps({ appsClient: { request } }));
    expect(request).not.toHaveBeenCalled();
    openApps(view);
    await waitForSolid(() => expect(view.container.textContent).toContain("Update on device"));
    expect(request).toHaveBeenCalledWith("node.list", {});
    expect(view.container.querySelector("#updates-apps-tab .updates-tabs__available")).toBeNull();
    select(view, "node:Tablet");
    const panel = view.container.querySelector("#updates-apps-panel")!;
    expect(panel.textContent).toContain("Offline");
    expect(panel.textContent).toContain("Not reported");
    expect(panel.textContent).not.toContain("not-app");
    expect([...panel.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Refresh",
    ]);
  });

  it("deduplicates only exact local nodeId and never applies native controls to a remote selection", async () => {
    const view = createUpdatesViewDom();
    const snapshot = createNativeDeviceSettingsSnapshot();
    snapshot.device.nodeId = "local";
    const nativeDeviceSettings = nativeSettings(snapshot);
    const request = vi.fn().mockResolvedValue({
      nodes: [
        app("local", { clientId: "openclaw-macos" }),
        app("Other Mac", { clientId: "openclaw-macos" }),
      ],
    });
    view.mountUpdates(createUpdatesViewProps({ nativeDeviceSettings, appsClient: { request } }));
    openApps(view);
    await waitForSolid(() =>
      expect(view.container.querySelector('option[value="node:Other Mac"]')).not.toBeNull(),
    );
    expect(view.container.querySelector('option[value="node:local"]')).toBeNull();
    select(view, "node:Other Mac");
    expect(view.container.querySelector('#updates-apps-panel input[role="switch"]')).toBeNull();
    expect(view.container.querySelector("#updates-apps-panel")!.textContent).not.toContain(
      "Check now",
    );
    expect(nativeDeviceSettings.set).not.toHaveBeenCalled();
    expect(nativeDeviceSettings.checkForUpdates).not.toHaveBeenCalled();
  });

  it("keeps the local updater usable before the inventory read settles", async () => {
    const view = createUpdatesViewDom();
    const inventory = createDeferred<{ nodes: NodeListNode[] }>();
    const nativeDeviceSettings = nativeSettings(createNativeDeviceSettingsSnapshot());
    const request = vi.fn().mockReturnValue(inventory.promise);
    view.mountUpdates(createUpdatesViewProps({ nativeDeviceSettings, appsClient: { request } }));
    openApps(view);
    const check = [
      ...view.container.querySelectorAll<HTMLButtonElement>("#updates-apps-panel button"),
    ].find((button) => button.textContent === "Check now");
    expect(check).toBeDefined();
    check!.click();
    expect(nativeDeviceSettings.checkForUpdates).toHaveBeenCalledOnce();
    inventory.resolve({ nodes: [app("Phone")] });
    await waitForSolid(() =>
      expect(view.container.querySelector('option[value="node:Phone"]')).not.toBeNull(),
    );
    select(view, "node:Phone");
    expect(view.container.querySelector("#updates-apps-panel")!.textContent).not.toContain(
      "Check now",
    );
  });

  it("keeps the local updater usable when the Gateway inventory read fails", async () => {
    const view = createUpdatesViewDom();
    const nativeDeviceSettings = nativeSettings(createNativeDeviceSettingsSnapshot());
    const request = vi.fn().mockRejectedValue(new Error("Inventory unavailable"));
    view.mountUpdates(createUpdatesViewProps({ nativeDeviceSettings, appsClient: { request } }));
    openApps(view);
    await waitForSolid(() => expect(view.container.textContent).toContain("Inventory unavailable"));
    const check = [
      ...view.container.querySelectorAll<HTMLButtonElement>("#updates-apps-panel button"),
    ].find((button) => button.textContent === "Check now")!;
    check.click();
    expect(nativeDeviceSettings.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("retires an old connection read and recovers a failed inventory read", async () => {
    const view = createUpdatesViewDom();
    const old = createDeferred<{ nodes: NodeListNode[] }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockRejectedValueOnce(new Error("Inventory unavailable"))
      .mockResolvedValue({ nodes: [app("New Phone")] });
    const props = createUpdatesViewProps({ appsClient: { request }, appsConnectionRevision: 1 });
    view.mountUpdates(props);
    openApps(view);
    view.mountUpdates({ ...props, appsConnectionRevision: 2 });
    await waitForSolid(() => expect(view.container.textContent).toContain("Inventory unavailable"));
    old.resolve({ nodes: [app("Old Phone")] });
    await waitForSolid(() => expect(view.container.textContent).not.toContain("Old Phone"));
    [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Retry")!
      .click();
    await waitForSolid(() => expect(view.container.textContent).toContain("New Phone"));
  });
});
