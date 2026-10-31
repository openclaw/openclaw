// @vitest-environment jsdom
import { For } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createProgressiveList } from "./progressive-list.ts";

const rows = Array.from({ length: 8 }, (_, id) => ({ id, name: `Field ${id}` }));

function Fields(props: { rows: typeof rows; enabled?: boolean }) {
  const visible = createProgressiveList(() => props.rows, {
    initial: 2,
    batch: 2,
    enabled: () => props.enabled !== false,
  });
  return (
    <div aria-busy={visible.pending() ? "true" : "false"}>
      <For each={visible.items()} keyed={(row) => row.id}>
        {(row) => <input aria-label={row().name} defaultValue={row().name} />}
      </For>
    </div>
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("cancels unfinished mounting on disposal and leaves non-opted-in lists synchronous", async () => {
  const view = mountSolid(Fields, { rows });
  expect(view.container.querySelectorAll("input")).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(1);
  view.dispose();
  expect(vi.getTimerCount()).toBe(0);
  await vi.runAllTimersAsync();
  flush();
  expect(view.container.children).toHaveLength(0);

  const synchronous = mountSolid(Fields, { rows, enabled: false });
  try {
    expect(synchronous.container.querySelectorAll("input")).toHaveLength(8);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    synchronous.dispose();
  }
});
