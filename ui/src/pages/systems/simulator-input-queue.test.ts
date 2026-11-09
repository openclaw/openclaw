import { expect, it, vi } from "vitest";
import { SimulatorInputQueue } from "./simulator-input-queue.ts";

it("drops queued pointer input when Computer Control becomes view only", async () => {
  let canControl = true;
  let finishFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const delivered = vi.fn();
  const errors = vi.fn();
  const queue = new SimulatorInputQueue(() => canControl, errors);
  const down = queue.enqueue(async () => {
    delivered("down");
    await first;
  });
  const move = queue.enqueue(async () => delivered("move"));
  await Promise.resolve();
  canControl = false;
  queue.retire();
  finishFirst?.();
  await Promise.all([down, move]);
  expect(delivered.mock.calls).toEqual([["down"]]);
  expect(errors).not.toHaveBeenCalled();
});
