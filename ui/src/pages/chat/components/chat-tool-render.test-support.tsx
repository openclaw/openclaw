import { createSignal } from "solid-js";
import { onTestFinished } from "vitest";
import { LitContent } from "../../../lit/solid-content.tsx";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";

export async function settleToolBridges(container: HTMLElement) {
  const settled = new Set<HTMLElement>();
  // A parent commit can connect another bridge that was parked in its child fragment.
  for (;;) {
    flush();
    const pending = Array.from(
      container.querySelectorAll<HTMLElement & { updateComplete?: Promise<unknown> }>("*"),
    ).filter((element) => element.updateComplete && !settled.has(element));
    if (pending.length === 0) {
      return;
    }
    pending.forEach((element) => settled.add(element));
    await Promise.all(pending.map((element) => Promise.resolve(element.updateComplete)));
  }
}

const fixtureUpdates = new Map<HTMLElement, (value: unknown) => void>();

// Legacy render helpers still return opaque templates; the fixture root is Solid-owned.
export async function renderToolFixture(value: unknown, container: HTMLElement) {
  const update = fixtureUpdates.get(container);
  if (update) {
    update(value);
  } else {
    if (!container.isConnected) {
      document.body.append(container);
    }
    let set!: (value: unknown) => void;
    const root = mountSolid(
      () => {
        const [current, setCurrent] = createSignal(value);
        set = (next) => setCurrent(() => next);
        return <LitContent value={current()} />;
      },
      { container },
    );
    fixtureUpdates.set(container, set);
    onTestFinished(() => {
      fixtureUpdates.delete(container);
      root.unmount();
      container.remove();
    });
  }
  flush();
  await settleToolBridges(container);
}
