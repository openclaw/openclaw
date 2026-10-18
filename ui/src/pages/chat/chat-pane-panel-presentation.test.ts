import { expect, it } from "vitest";
import "../../components/desktop/desktop-panel.ts";
import {
  createReviewFixture,
  renderPanelFixture,
  sidebarPanelFixtureParams,
} from "../../test-helpers/chat-pane-embedded-panels.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { openSlot } from "./sidebar-layout.ts";

it("keeps the native Desktop window action when desktop headers delegate actions to the panel", async () => {
  const { state, mount } = createReviewFixture();
  state.sidebarLayout = openSlot(state.sidebarLayout, "desktop");
  const href = "/desktop?session=agent%3Amain%3Areview-intent";
  const definitions = sidebarPanelDefinitions(
    sidebarPanelFixtureParams(state, {
      presentation: "desktop",
      desktopAvailable: true,
      desktopFocusHref: href,
    }),
  );
  expect(
    definitions.find((definition) => definition.slot === "desktop")?.headerLink,
  ).toBeUndefined();
  await renderPanelFixture(mount, state.sidebarLayout, definitions);
  const desktop = mount.querySelector("openclaw-desktop-panel")!;
  await desktop.updateComplete;
  expect(desktop.presentation).toMatchObject({ platform: "desktop", openWindowHref: href });
  const openWindow = desktop.querySelector<HTMLAnchorElement>(
    'a[aria-label="Open desktop in new window"]',
  );
  expect(openWindow).not.toBeNull();
  expect(openWindow?.getAttribute("href")).toBe(href);
  expect(openWindow?.checkVisibility()).toBe(true);

  const mobile = sidebarPanelDefinitions(
    sidebarPanelFixtureParams(state, {
      presentation: "mobile",
      desktopAvailable: true,
      desktopFocusHref: href,
    }),
  );
  expect(mobile.find((definition) => definition.slot === "desktop")?.headerLink?.href).toBe(href);
  await renderPanelFixture(mount, state.sidebarLayout, mobile);
  expect(mount.querySelector("openclaw-desktop-panel")).toBe(desktop);
  expect(desktop.presentation).toMatchObject({ platform: "mobile" });
  expect(desktop.presentation?.openWindowHref).toBeUndefined();
});
