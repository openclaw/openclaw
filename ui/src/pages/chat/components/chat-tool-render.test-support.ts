import { vi } from "vitest";
import { flush } from "../../../test-helpers/solid-settle.ts";

export async function settleToolBridges(container: HTMLElement) {
  flush();
  await vi.dynamicImportSettled();
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
