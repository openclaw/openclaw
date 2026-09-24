import { describe, expect, it, vi } from "vitest";
import { bootstrapApplication } from "./bootstrap.ts";
import { loadSettings, saveSettings, setSettingsChangeListener } from "./settings.ts";

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
});
