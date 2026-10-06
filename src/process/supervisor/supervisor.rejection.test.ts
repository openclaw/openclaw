import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createProcessSupervisor } from "./supervisor.js";
import { createStubChildAdapter } from "./supervisor.test-support.js";

const mocks = vi.hoisted(() => ({ createChildAdapter: vi.fn() }));
vi.mock("./adapters/child.js", () => ({ createChildAdapter: mocks.createChildAdapter }));

it("retains an early run failure until the caller requests its result", async () => {
  const result = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const cleanup = createDeferred();
  const adapter = {
    ...createStubChildAdapter(),
    wait: () => result.promise,
    waitForExtinction: () => cleanup.promise,
  };
  mocks.createChildAdapter.mockResolvedValue({ adapter, ready: Promise.resolve() });
  const supervisor = createProcessSupervisor();
  const run = await supervisor.spawn({ mode: "child", argv: ["synthetic-child"] });
  const unhandled = vi.fn();
  const failure = new Error("synthetic early result failure");
  process.on("unhandledRejection", unhandled);
  try {
    result.reject(failure);
    await nextTurn();
    await nextTurn();
    expect(unhandled).not.toHaveBeenCalled();
    await expect(run.wait()).rejects.toBe(failure);
  } finally {
    await run.wait().catch(() => undefined);
    cleanup.resolve();
    await supervisor.shutdown();
    process.off("unhandledRejection", unhandled);
  }
});
