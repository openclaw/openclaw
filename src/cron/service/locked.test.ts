import path from "node:path";
import { describe, expect, it } from "vitest";
import { locked } from "./locked.js";
import type { CronServiceState } from "./state.js";

function createLockState(storePath: string): CronServiceState {
  return {
    deps: { storePath },
    op: Promise.resolve(),
  } as CronServiceState;
}

describe("cron service store lock", () => {
  it("serializes relative and absolute spellings of the same store", async () => {
    const absoluteStorePath = path.resolve(".artifacts", "cron-lock-test.sqlite");
    const relativeState = createLockState(path.relative(process.cwd(), absoluteStorePath));
    const absoluteState = createLockState(absoluteStorePath);
    let releaseFirst = () => {};
    let markFirstStarted = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let secondStarted = false;

    const first = locked(relativeState, async () => {
      markFirstStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    await firstStarted;
    const second = locked(absoluteState, async () => {
      secondStarted = true;
    });
    await Promise.resolve();
    expect(secondStarted).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
  });
});
