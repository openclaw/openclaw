import { render } from "lit";
import { onTestFinished } from "vitest";

export async function settleToolBridges(container: HTMLElement) {
  await Promise.all(
    Array.from(
      container.querySelectorAll<HTMLElement & { updateComplete?: Promise<unknown> }>("*"),
      (element) => element.updateComplete,
    ),
  );
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
