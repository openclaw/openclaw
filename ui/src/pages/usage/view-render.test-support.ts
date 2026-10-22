import { createSignal } from "solid-js";
import { vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { UsageProps } from "./types.ts";
import { createUsageProps } from "./view.test-support.ts";

export function mountView(render: Parameters<typeof mountSolid>[0]) {
  const view = mountSolid(render);
  flush();
  return view;
}

export function texts(root: ParentNode, selector: string, trim = true) {
  return Array.from(root.querySelectorAll(selector), (node) =>
    trim ? node.textContent?.trim() : node.textContent,
  );
}

export const text = (root: ParentNode | null | undefined, selector: string) =>
  root?.querySelector(selector)?.textContent;

export function usageState(
  initialFilters: Partial<UsageProps["filters"]> = {},
  data?: (base: UsageProps["data"]) => UsageProps["data"],
) {
  const base = createUsageProps();
  const [filters, setFilters] = createSignal({ ...base.filters, ...initialFilters });
  const [display, setDisplay] = createSignal(base.display);
  const onChange = vi.fn((patch: Partial<UsageProps["display"]>) =>
    setDisplay((current) => ({ ...current, ...patch })),
  );
  const onDatesChange = vi.fn((patch: Partial<UsageProps["filters"]>) =>
    setFilters((current) => ({ ...current, ...patch })),
  );
  const usage = {
    ...base,
    get data() {
      return data ? data(base.data) : base.data;
    },
    get filters() {
      return filters();
    },
    get display() {
      return display();
    },
    callbacks: {
      ...base.callbacks,
      filters: { ...base.callbacks.filters, onDatesChange },
      display: { ...base.callbacks.display, onChange },
    },
  };
  return { base, usage, setFilters, setDisplay, onChange, onDatesChange };
}
