/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createNoopSidebarRegionCallbacks } from "../../test-helpers/sidebar-region-callbacks.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createChatMobileHostFixture } from "./chat-mobile-host.test-support.ts";
import type { ChatMobileHost } from "./chat-mobile-host.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
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
      callbacks={createNoopSidebarRegionCallbacks()}
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

it("retains loading contents, primary input and outlet through resize and collapse", () => {
  const primary = document.createElement("textarea");
  primary.value = "Draft survives the side panel";
  const layout = openSlot({ columns: [] }, "workspace");
  const [width, resize] = createSignal(1400);
  const [open, changeOpen] = createSignal(true);
  const mounted = mountSolid(() => (
    <SidebarRegionView
      presentationId="loading-layout"
      panelIdPrefix="chat-panel-loading-layout"
      availableWidth={width()}
      narrow={false}
      callbacks={createNoopSidebarRegionCallbacks()}
      layout={setSidebarOpen(fitSidebarLayout(layout, width())!, open())}
      panelDefinitions={sidebarPanelDefinitions()}
      primary={primary}
    />
  ));
  flush();
  const panel = mounted.container.querySelector(".side-panel__panel")!;
  const placeholder = panel.querySelector("openclaw-panel-loading-skeleton")!;
  const contents = placeholder.querySelector(".rows")!;
  resize(700);
  flush();
  expect(mounted.container.querySelector(".side-panel__panel")).toBe(panel);
  expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBe(placeholder);
  expect(placeholder.querySelector(".rows")).toBe(contents);
  const region = mounted.container.querySelector<HTMLElement>(".sidebar-region")!;
  expect(region.style.getPropertyValue("--side-panel-width")).toBe("382px");
  const outlet = mounted.container.querySelector(".sidebar-region__right-runtime")!;
  const retainedPanel = document.createElement("iframe");
  outlet.append(retainedPanel);
  changeOpen(false);
  flush();
  expect(mounted.container.querySelector("textarea")).toBe(primary);
  expect(primary.value).toBe("Draft survives the side panel");
  expect(mounted.container.querySelector(".sidebar-region__right-runtime")).toBe(outlet);
  expect(retainedPanel.parentElement).toBe(outlet);
  expect(region.classList.contains("sidebar-region--open")).toBe(false);
});

it("routes portalled mobile events and releases refs when the region or view unmounts", async () => {
  const mobileHost = createChatMobileHostFixture("portalled-events", { open: true });
  const primary = document.createElement("textarea");
  const refs: Record<"region" | "header" | "view", HTMLElement | null> = {
    region: null,
    header: null,
    view: null,
  };
  const capture = (key: keyof typeof refs) => (element: HTMLElement) => {
    refs[key] = element;
    return () => {
      if (refs[key] === element) {
        refs[key] = null;
      }
    };
  };
  const [pending, loading] = createSignal(false);
  const mounted = mountSolid(() => (
    <SidebarRegionView
      presentationId="portalled-events"
      panelIdPrefix="chat-portalled-events"
      availableWidth={400}
      narrow
      mobileHost={mobileHost}
      layout={pending() ? { columns: [] } : openSlot({ columns: [] }, "workspace")}
      panelDefinitions={sidebarPanelDefinitions().map((definition) =>
        definition.slot === "workspace"
          ? Object.assign(definition, {
              content: (
                <>
                  <input
                    aria-label="Panel search"
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && event.currentTarget.value === "nested") {
                        event.preventDefault();
                      }
                    }}
                  />
                  <input aria-label="Read-only preview" readonly />
                </>
              ),
            })
          : definition,
      )}
      callbacks={createNoopSidebarRegionCallbacks()}
      primary={primary}
      onRegionElementRef={capture("region")}
      onRegionViewRef={capture("view")}
      onHeaderElementRef={capture("header")}
    />
  ));
  await waitForSolid(() => expect(mounted.queryByLabelText("Panel search")).not.toBeNull());
  const { region, view, header } = refs;
  expect(region).toBe(mounted.container.querySelector(".sidebar-region"));
  expect(header).toBe(mounted.container.querySelector(".sidebar-region__header"));
  expect(view).toBe(mounted.container.querySelector("openclaw-chat-sidebar-region"));
  const input = mounted.getByLabelText<HTMLInputElement>("Panel search");
  expect(input.closest(".chat-mobile-host")).not.toBeNull();
  input.focus();
  expect(mobileHost.toggleExpanded).toHaveBeenCalledOnce();
  mounted.getByLabelText("Read-only preview").focus();
  primary.focus();
  const escape = (init: KeyboardEventInit = {}) =>
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
  primary.dispatchEvent(escape());
  expect(mobileHost.toggleExpanded).toHaveBeenCalledOnce();
  expect(mobileHost.close).not.toHaveBeenCalled();
  for (const control of [{ isComposing: true }, { keyCode: 229 }]) {
    input.dispatchEvent(escape(control));
    expect(mobileHost.close).not.toHaveBeenCalled();
  }
  input.value = "nested";
  const nestedEscape = escape();
  input.dispatchEvent(nestedEscape);
  expect(nestedEscape.defaultPrevented).toBe(true);
  expect(mobileHost.close).not.toHaveBeenCalled();
  input.value = "";
  const hostEscape = escape();
  input.dispatchEvent(hostEscape);
  expect(hostEscape.defaultPrevented).toBe(true);
  expect(mobileHost.close).toHaveBeenCalledOnce();
  loading(true);
  flush();
  expect(refs.view).toBeNull();
  expect(refs.region).toBe(region);
  expect(refs.header).toBe(header);
  loading(false);
  flush();
  await waitForSolid(() => expect(refs.view).not.toBeNull());
  expect(refs.view).not.toBe(view);
  mounted.unmount();
  expect(refs).toEqual({ region: null, header: null, view: null });
});
