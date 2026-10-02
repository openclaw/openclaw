import { describe, expect, it } from "vitest";
import {
  clearSessionPanelToggle,
  rememberSessionPanelToggle,
  takeSessionPanelToggle,
} from "./session-panel-toggle-buffer.ts";

describe("session panel toggle buffer", () => {
  it("lets a buffered close cancel all earlier reader opens", () => {
    const open = (url: string) =>
      new CustomEvent("openclaw:link-reader-toggle", { detail: { url, open: true } });
    rememberSessionPanelToggle("link-reader", open("https://forge.example/items/1"));
    rememberSessionPanelToggle("link-reader", open("https://forge.example/items/2"));
    const close = new CustomEvent("openclaw:link-reader-toggle", { detail: { open: false } });
    rememberSessionPanelToggle("link-reader", close);
    expect(takeSessionPanelToggle("link-reader")).toBe(close);
    expect(takeSessionPanelToggle("link-reader")).toBeNull();
  });

  it("keeps each conversation's target until that conversation claims it", () => {
    const first = new CustomEvent("openclaw:portal-toggle", {
      detail: { sessionKey: "agent:main:first", open: true, portalId: "first-app" },
    });
    const second = new CustomEvent("openclaw:portal-toggle", {
      detail: { sessionKey: "agent:main:second", open: true, portalId: "second-app" },
    });
    rememberSessionPanelToggle("portal", first);
    rememberSessionPanelToggle("portal", second);

    expect(takeSessionPanelToggle("portal", "agent:main:unrelated")).toBeNull();
    expect(takeSessionPanelToggle("portal", "agent:main:second")).toBe(second);
    expect(takeSessionPanelToggle("portal", "agent:main:first")).toBe(first);
  });

  it("keeps an early route-startup intent until the pane claims it", () => {
    const event = new CustomEvent("openclaw:desktop-toggle", {
      detail: { open: true, environmentId: "worker-desktop-1" },
    });
    rememberSessionPanelToggle("desktop", event);

    expect(takeSessionPanelToggle("desktop")).toBe(event);
    expect(takeSessionPanelToggle("desktop")).toBeNull();
  });

  it("does not let an older direct delivery clear a newer intent", () => {
    const older = new Event("openclaw:browser-toggle");
    const newer = new Event("openclaw:browser-toggle");
    rememberSessionPanelToggle("browser", older);
    rememberSessionPanelToggle("browser", newer);

    clearSessionPanelToggle("browser", older);

    expect(takeSessionPanelToggle("browser")).toBe(newer);
  });
});
