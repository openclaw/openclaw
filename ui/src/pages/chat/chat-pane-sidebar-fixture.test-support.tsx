import type { JSX } from "@solidjs/web";
import { createSignal, type Setter } from "solid-js";
import { vi } from "vitest";
import { mountSolid, type MountSolidOptions } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { SidebarRegionView, type SidebarRegionViewProps } from "./chat-pane-sidebar-view.tsx";

export function mountState<T>(
  initial: T,
  View: (props: { value: T }) => JSX.Element,
  options?: MountSolidOptions,
) {
  let set!: Setter<T>;
  let read!: () => T;
  const mounted = mountSolid(() => {
    const [state, update] = createSignal(initial);
    read = state;
    set = update;
    return <View value={state()} />;
  }, options);
  flush();
  return {
    ...mounted,
    read,
    update: (value: T) => {
      set(() => value);
      flush();
    },
    modify: (update: (previous: T) => T) => {
      set(update);
      flush();
    },
  };
}

export function sidebarCallbacks() {
  return {
    activatePanel: vi.fn(),
    togglePanelExpanded: vi.fn(),
    closeSlot: vi.fn(),
    openSlot: vi.fn(),
    reorderPanel: vi.fn(),
    resizePanel: vi.fn(),
    setOpen: vi.fn(),
  };
}

export function SidebarFixture(
  props: Partial<SidebarRegionViewProps> & Pick<SidebarRegionViewProps, "layout">,
) {
  const panels = sidebarPanelDefinitions();
  const callbacks = sidebarCallbacks();
  return (
    <SidebarRegionView
      presentationId="sidebar-layout-fixture"
      panelIdPrefix={`chat-panel-${encodeURIComponent(props.presentationId ?? "sidebar-layout-fixture")}`}
      availableWidth={1400}
      narrow={false}
      callbacks={callbacks}
      panelDefinitions={panels}
      regionError={undefined}
      {...props}
    />
  );
}
