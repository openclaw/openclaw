/* @vitest-environment jsdom */

import { Show } from "solid-js";
import { expect, it } from "vitest";
import { PRESENTATION_CHANGED_EVENT, type PresentationBinding } from "../../lib/presentation.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { usePanePresentation } from "./chat-pane-presentation.ts";
import { mountState, SidebarFixture } from "./chat-pane-sidebar-fixture.test-support.tsx";
import { fitSidebarLayout, openSlot, setSidebarOpen } from "./sidebar-layout.ts";

it("retains loading panel contents when fitting a new layout snapshot", () => {
  const layout = openSlot({ columns: [] }, "workspace");
  const mounted = mountState(1400, (width) => (
    <SidebarFixture
      presentationId="loading-layout"
      availableWidth={width.value}
      layout={fitSidebarLayout(layout, width.value)!}
      regionError={null}
    />
  ));
  const panel = mounted.container.querySelector(".side-panel__panel")!;
  const placeholder = panel.querySelector("openclaw-panel-loading-skeleton")!;
  const contents = placeholder.querySelector(".rows")!;
  mounted.update(700);
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
  const mounted = mountState(true, (open) => (
    <SidebarFixture
      presentationId="native-layout"
      layout={setSidebarOpen(layout, open.value)}
      regionError={null}
      primary={primary}
    />
  ));
  const outlet = mounted.container.querySelector(".sidebar-region__right-runtime")!;
  const retainedPanel = document.createElement("iframe");
  outlet.append(retainedPanel);
  mounted.update(false);
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
  const mounted = mountState(binding, (presentation) => {
    const active = usePanePresentation(() => presentation.value);
    return <Show when={active()}>{content}</Show>;
  });
  expect(mounted.container.querySelector("input")).toBe(content);
  presented = false;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  flush();
  expect(mounted.container.querySelector("input")).toBeNull();
  presented = true;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  flush();
  expect(mounted.container.querySelector("input")).toBeNull();
  mounted.update({ ...binding });
  expect(mounted.container.querySelector("input")).toBe(content);
  expect(content.value).toBe("Retained text");
});

it("releases region refs when the lazy host or its containing view unmounts", () => {
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
  const mounted = mountState(false, (pending) => (
    <SidebarFixture
      presentationId="owned-region-refs"
      layout={{ columns: [] }}
      regionError={pending.value ? null : undefined}
      onRegionElementRef={capture("region")}
      onRegionViewRef={capture("view")}
      onHeaderElementRef={capture("header")}
    />
  ));
  const { region: shell, view: firstView, header } = refs;
  expect(shell).toBe(mounted.container.querySelector(".sidebar-region"));
  expect(header).toBe(mounted.container.querySelector(".sidebar-region__header"));
  expect(firstView).toBe(mounted.container.querySelector("openclaw-chat-sidebar-region"));
  mounted.update(true);
  expect(refs.view).toBeNull();
  expect(refs.region).toBe(shell);
  expect(refs.header).toBe(header);
  mounted.update(false);
  expect(refs.view).not.toBeNull();
  expect(refs.view).not.toBe(firstView);
  mounted.unmount();
  expect(refs).toEqual({ region: null, header: null, view: null });
});
