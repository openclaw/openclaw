/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { PRESENTATION_CHANGED_EVENT, type PresentationBinding } from "../../lib/presentation.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { PresentedPaneContent } from "./chat-pane-embedded-view.tsx";
import { SidebarRegionView } from "./chat-pane-sidebar-view.tsx";
import { openSlot, setSidebarOpen } from "./sidebar-layout.ts";

// The lazy region separately owns the successful right outlet's contents.
afterEach(cleanupSolid);

it("retains the primary input and the region-owned outlet while changing the layout", () => {
  const primary = document.createElement("textarea");
  primary.value = "Draft survives the side panel";
  const layout = openSlot({ columns: [] }, "workspace");
  let changeOpen: (open: boolean) => void = () => {};
  const mounted = mountSolid(() => {
    const [open, setOpen] = createSignal(true);
    changeOpen = setOpen;
    return (
      <SidebarRegionView
        presentationId="native-layout"
        panelIdPrefix="chat-panel-native-layout"
        availableWidth={1400}
        narrow={false}
        callbacks={{
          activatePanel() {},
          togglePanelExpanded() {},
          closeSlot() {},
          openSlot() {},
          reorderPanel() {},
          resizePanel() {},
          setOpen() {},
        }}
        layout={setSidebarOpen(layout, open())}
        panelDefinitions={sidebarPanelDefinitions()}
        regionError={null}
        primary={primary}
        requestUpdate={() => {}}
      />
    );
  });
  flush();
  const outlet = mounted.container.querySelector(".sidebar-region__right-runtime")!;
  const retainedPanel = document.createElement("iframe");
  outlet.append(retainedPanel);
  changeOpen(false);
  flush();
  expect(mounted.container.querySelector("textarea")).toBe(primary);
  expect(primary.value).toBe("Draft survives the side panel");
  expect(mounted.container.querySelector(".sidebar-region__right-runtime")).toBe(outlet);
  expect(retainedPanel.parentElement).toBe(outlet);
  expect(
    mounted.container.querySelector(".sidebar-region")?.classList.contains("sidebar-region--open"),
  ).toBe(false);
});

it("parks on owner events and reveals only with the matching parent props", () => {
  const owner = new EventTarget();
  let presented = true;
  const binding: PresentationBinding = { owner, isPresented: () => presented };
  const content = document.createElement("input");
  content.value = "Retained text";
  let repaint: () => void = () => {};
  const mounted = mountSolid(() => {
    const [presentation, setPresentation] = createSignal(binding);
    repaint = () => setPresentation({ ...binding });
    return <PresentedPaneContent presentation={presentation()} content={content} />;
  });
  flush();
  expect(mounted.container.querySelector("input")).toBe(content);
  presented = false;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  flush();
  expect(mounted.container.querySelector("input")).toBeNull();
  presented = true;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  flush();
  expect(mounted.container.querySelector("input")).toBeNull();
  repaint();
  flush();
  expect(mounted.container.querySelector("input")).toBe(content);
  expect(content.value).toBe("Retained text");
});
