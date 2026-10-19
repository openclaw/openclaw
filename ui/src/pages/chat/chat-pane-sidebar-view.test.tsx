/* @vitest-environment jsdom */

import { createSignal, Show } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { PRESENTATION_CHANGED_EVENT, type PresentationBinding } from "../../lib/presentation.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { usePanePresentation } from "./chat-pane-presentation.ts";
import { SidebarRegionView } from "./chat-pane-sidebar-view.tsx";
import { fitSidebarLayout, openSlot, setSidebarOpen } from "./sidebar-layout.ts";

// The lazy region separately owns the successful right outlet's contents.
afterEach(cleanupSolid);

it("retains loading panel contents when fitting a new layout snapshot", () => {
  const layout = openSlot({ columns: [] }, "workspace");
  let resize: (width: number) => void = () => {};
  const mounted = mountSolid(() => {
    const [width, setWidth] = createSignal(1400);
    resize = setWidth;
    return (
      <SidebarRegionView
        presentationId="loading-layout"
        panelIdPrefix="chat-panel-loading-layout"
        availableWidth={width()}
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
        layout={fitSidebarLayout(layout, width())!}
        panelDefinitions={sidebarPanelDefinitions()}
        regionError={null}
      />
    );
  });
  flush();
  const panel = mounted.container.querySelector(".side-panel__panel")!;
  const placeholder = panel.querySelector("openclaw-panel-loading-skeleton")!;
  const contents = placeholder.querySelector(".rows")!;
  resize(700);
  flush();
  expect(mounted.container.querySelector(".side-panel__panel")).toBe(panel);
  expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBe(placeholder);
  expect(placeholder.querySelector(".rows")).toBe(contents);
  expect(
    mounted.container
      .querySelector<HTMLElement>(".sidebar-region")
      ?.style.getPropertyValue("--side-panel-width"),
  ).toBe("382px");
});

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

it("parks on owner events and reveals with the parent's next props", () => {
  const owner = new EventTarget();
  let presented = true;
  const binding: PresentationBinding = { owner, isPresented: () => presented };
  const content = document.createElement("input");
  content.value = "Retained text";
  let repaint: () => void = () => {};
  const mounted = mountSolid(() => {
    const [presentation, setPresentation] = createSignal(binding);
    repaint = () => setPresentation({ ...binding });
    const active = usePanePresentation(presentation);
    return <Show when={active()}>{content}</Show>;
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

it("releases region refs when the lazy host or its containing view unmounts", () => {
  let regionElement: HTMLElement | null = null;
  let regionView: HTMLElementTagNameMap["openclaw-chat-sidebar-region"] | null = null;
  let loading: (value: boolean) => void = () => {};
  const mounted = mountSolid(() => {
    const [pending, setPending] = createSignal(false);
    loading = setPending;
    return (
      <SidebarRegionView
        presentationId="owned-region-refs"
        panelIdPrefix="chat-owned-region-refs"
        availableWidth={1400}
        narrow={false}
        layout={{ columns: [] }}
        panelDefinitions={sidebarPanelDefinitions()}
        callbacks={{
          activatePanel() {},
          togglePanelExpanded() {},
          closeSlot() {},
          openSlot() {},
          reorderPanel() {},
          resizePanel() {},
          setOpen() {},
        }}
        regionError={pending() ? null : undefined}
        onRegionElementRef={(element) => {
          regionElement = element;
          return () => {
            if (regionElement === element) {
              regionElement = null;
            }
          };
        }}
        onRegionViewRef={(element) => {
          regionView = element;
          return () => {
            if (regionView === element) {
              regionView = null;
            }
          };
        }}
      />
    );
  });
  flush();
  const shell = regionElement;
  const firstView = regionView;
  expect(shell).toBe(mounted.container.querySelector(".sidebar-region"));
  expect(firstView).toBe(mounted.container.querySelector("openclaw-chat-sidebar-region"));
  loading(true);
  flush();
  expect(regionView).toBeNull();
  expect(regionElement).toBe(shell);
  loading(false);
  flush();
  expect(regionView).not.toBeNull();
  expect(regionView).not.toBe(firstView);
  mounted.unmount();
  expect(regionView).toBeNull();
  expect(regionElement).toBeNull();
});
