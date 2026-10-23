/* @vitest-environment jsdom */

import { createSignal, Show } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { PRESENTATION_CHANGED_EVENT, type PresentationBinding } from "../../lib/presentation.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { ChatMobileHost } from "./chat-mobile-host.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import { usePanePresentation } from "./chat-pane-presentation.ts";
import { SidebarRegionView } from "./chat-pane-sidebar-view.tsx";
import { getPaneTestRuntime } from "./chat-pane.test-support.ts";
import { fitSidebarLayout, openSlot, setSidebarOpen } from "./sidebar-layout.ts";

// The lazy region separately owns the successful right outlet's contents.
afterEach(cleanupSolid);

it("releases each mobile details mount when its host is replaced or removed", () => {
  const host = () => {
    const { pane } = createMountedPanes([]);
    getPaneTestRuntime(pane).mergedChrome = true;
    const read = () => pane.render().layout!.region.mobileHost!;
    read().navigate({ area: "details" });
    return read;
  };
  const first = host();
  const second = host();
  const firstSnapshot = first();
  const [mobileHost, replaceHost] = createSignal<ChatMobileHost | undefined>(firstSnapshot);
  const mounted = mountSolid(() => (
    <SidebarRegionView
      presentationId="details-mount-lifetime"
      panelIdPrefix="chat-details-mount-lifetime"
      availableWidth={400}
      narrow
      mobileHost={mobileHost()}
      layout={{ columns: [] }}
      panelDefinitions={sidebarPanelDefinitions()}
      callbacks={{
        activatePanel() {},
        togglePanelExpanded() {},
        setDock() {},
        closeSlot() {},
        openSlot() {},
        reorderPanel() {},
        resizePanel() {},
        setOpen() {},
      }}
    />
  ));
  flush();
  const details = mounted.container.querySelector(".chat-mobile-host__details");
  expect(details).not.toBeNull();
  expect(first().detailsMount).toBe(details);
  const nextSnapshot = first();
  expect(nextSnapshot).not.toBe(firstSnapshot);
  expect(nextSnapshot.setDetailsMount).toBe(firstSnapshot.setDetailsMount);
  replaceHost(nextSnapshot);
  flush();
  expect(first().detailsMount).toBe(details);
  replaceHost(second());
  flush();
  expect(first().detailsMount).toBeNull();
  expect(second().detailsMount).toBe(details);
  replaceHost(undefined);
  flush();
  expect(second().detailsMount).toBeNull();
  replaceHost(first());
  flush();
  expect(first().detailsMount).toBe(details);
  mounted.unmount();
  expect(first().detailsMount).toBeNull();
});

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
          setDock() {},
          closeSlot() {},
          openSlot() {},
          reorderPanel() {},
          resizePanel() {},
          setOpen() {},
        }}
        layout={fitSidebarLayout(layout, width())!}
        panelDefinitions={sidebarPanelDefinitions()}
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
          setDock() {},
          closeSlot() {},
          openSlot() {},
          reorderPanel() {},
          resizePanel() {},
          setOpen() {},
        }}
        layout={setSidebarOpen(layout, open())}
        panelDefinitions={sidebarPanelDefinitions()}
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

it("releases region refs when the panel column or its containing view unmounts", async () => {
  let regionElement: HTMLElement | null = null;
  let headerElement: HTMLElement | null = null;
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
        layout={pending() ? { columns: [] } : openSlot({ columns: [] }, "workspace")}
        panelDefinitions={sidebarPanelDefinitions()}
        callbacks={{
          activatePanel() {},
          togglePanelExpanded() {},
          setDock() {},
          closeSlot() {},
          openSlot() {},
          reorderPanel() {},
          resizePanel() {},
          setOpen() {},
        }}
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
        onHeaderElementRef={(element) => {
          headerElement = element;
          return () => {
            headerElement = null;
          };
        }}
      />
    );
  });
  flush();
  await waitForSolid(() => expect(regionView).not.toBeNull());
  const shell = regionElement;
  const firstView = regionView;
  const header = headerElement;
  expect(shell).toBe(mounted.container.querySelector(".sidebar-region"));
  expect(header).toBe(mounted.container.querySelector(".sidebar-region__header"));
  expect(firstView).toBe(mounted.container.querySelector("openclaw-chat-sidebar-region"));
  loading(true);
  flush();
  expect(regionView).toBeNull();
  expect(regionElement).toBe(shell);
  expect(headerElement).toBe(header);
  loading(false);
  flush();
  await waitForSolid(() => expect(regionView).not.toBeNull());
  expect(regionView).not.toBe(firstView);
  mounted.unmount();
  expect(regionView).toBeNull();
  expect(regionElement).toBeNull();
  expect(headerElement).toBeNull();
});
