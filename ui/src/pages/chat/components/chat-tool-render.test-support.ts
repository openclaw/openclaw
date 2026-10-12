import { render } from "lit";
import { onTestFinished } from "vitest";

export async function settleToolBridges(container: HTMLElement) {
  const settled = new Set<HTMLElement>();
  // A parent commit can connect another bridge that was parked in its child fragment.
  for (;;) {
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

// Exercise the actual Lit entry point, including connected Solid bridge roots.
export async function renderToolFixture(value: unknown, container: HTMLElement) {
  if (!container.isConnected) {
    document.body.append(container);
    onTestFinished(() => {
      render(null, container);
      container.remove();
    });
  }
  render(value, container);
  await settleToolBridges(container);
}
