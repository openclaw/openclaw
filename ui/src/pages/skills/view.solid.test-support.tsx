import { createSignal, flush } from "solid-js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import type { SkillsProps } from "./view-types.ts";
import { Skills } from "./view.tsx";

type MountedView = { update: (props: SkillsProps) => void; dispose: () => void };
let views = new WeakMap<HTMLElement, MountedView>();
const disposals = new Set<() => void>();

export function renderSkills(props: SkillsProps, container: HTMLElement) {
  let view = views.get(container);
  if (!view) {
    const [current, setCurrent] = createSignal(props, { ownedWrite: true });
    const mounted = mountSolid(() => <Skills {...current()} />, { container });
    view = { update: setCurrent, dispose: mounted.unmount };
    views.set(container, view);
    disposals.add(view.dispose);
  } else {
    view.update(props);
  }
  flush();
}

export function cleanupSkillsViews() {
  for (const dispose of disposals) {
    dispose();
  }
  disposals.clear();
  views = new WeakMap();
}
