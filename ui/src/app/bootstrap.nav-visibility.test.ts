import { describe, expect, it, vi } from "vitest";
import { bootstrapApplication } from "./bootstrap.ts";
import {
  loadSettings,
  patchSettings,
  saveSettings,
  setSettingsChangeListener,
  settingsKeyForGateway,
} from "./settings.ts";

describe("initial sidebar visibility", () => {
  it.each([
    "/chat/research/conversation?keep=yes#details",
    "/chat/research",
    "/chat",
    "/dashboard/research/conversation",
    "/settings/appearance",
    "/chat/research/conversation?nav=collapsed",
  ])("starts expanded without rewriting the route at %s", (initialUrl) => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    window.history.replaceState({}, "", initialUrl);
    let runtime: ReturnType<typeof bootstrapApplication> | undefined;

    try {
      runtime = bootstrapApplication();
      expect(runtime.context.navigation.snapshot.navCollapsed).toBe(false);
      expect(window.location.pathname + window.location.search + window.location.hash).toBe(
        initialUrl,
      );
    } finally {
      runtime?.stop();
      window.history.replaceState({}, "", previousUrl);
      saveSettings(previousSettings);
    }
  });

  it("keeps sidebar visibility in memory without rewriting persisted settings", () => {
    const previousSettings = loadSettings();
    let runtime: ReturnType<typeof bootstrapApplication> | undefined;
    const onPersistedSettingsChanged = vi.fn();

    try {
      runtime = bootstrapApplication();
      setSettingsChangeListener(onPersistedSettingsChanged);

      runtime.context.navigation.update({ navCollapsed: true });

      expect(runtime.context.navigation.snapshot.navCollapsed).toBe(true);
      expect(onPersistedSettingsChanged).not.toHaveBeenCalled();

      runtime.context.navigation.update({ navWidth: previousSettings.navWidth + 1 });

      expect(onPersistedSettingsChanged).toHaveBeenCalledOnce();
      expect(loadSettings().navWidth).toBe(previousSettings.navWidth + 1);
    } finally {
      runtime?.stop();
      setSettingsChangeListener(null);
      saveSettings(previousSettings);
    }
  });

  it.each([{ destinationOrder: [] }, { destinationOrder: ["work", "main"] }])(
    "uses the destination Gateway's agent order after a switch, even without a server delta ($destinationOrder)",
    ({ destinationOrder }) => {
      const previousSettings = loadSettings();
      const first = "ws://sidebar-order-first.example";
      const second = "ws://sidebar-order-second.example";
      let runtime: ReturnType<typeof bootstrapApplication> | undefined;
      try {
        saveSettings({
          ...loadSettings(first),
          gatewayUrl: first,
          sidebarAgentOrder: ["main", "work"],
        });
        saveSettings({
          ...loadSettings(second),
          gatewayUrl: second,
          sidebarAgentOrder: destinationOrder,
        });
        patchSettings({ gatewayUrl: first });
        runtime = bootstrapApplication();
        expect(runtime.context.navigation.snapshot.sidebarAgentOrder).toEqual(["main", "work"]);

        runtime.context.gateway.connect({ gatewayUrl: second });
        expect(runtime.context.navigation.snapshot.sidebarAgentOrder).toEqual(destinationOrder);
        runtime.context.navigation.update({
          navWidth: runtime.context.navigation.snapshot.navWidth + 1,
        });
        expect(loadSettings(second).sidebarAgentOrder).toEqual(destinationOrder);
        expect(loadSettings(first).sidebarAgentOrder).toEqual(["main", "work"]);
      } finally {
        runtime?.stop();
        localStorage.removeItem(settingsKeyForGateway(first));
        localStorage.removeItem(settingsKeyForGateway(second));
        patchSettings({ gatewayUrl: previousSettings.gatewayUrl });
        saveSettings(previousSettings);
      }
    },
  );
});
