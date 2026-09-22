import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import net from "node:net";
import { expect, it, vi } from "vitest";
import * as ports from "../../src/test-utils/ports.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";
import { createDeferred } from "./promise.js";

it("keeps overlapping fixture allocations exclusive before their reservation binds", async () => {
  vi.resetModules();
  const secondPicker = (await import("../../src/test-utils/ports.js"))
    .getDeterministicFreePortBlock;
  const firstPicker = ports.getDeterministicFreePortBlock;
  const owner = new AsyncLocalStorage<string>();
  // Independent module copies model workers with the same initial candidate.
  const pickerSpy = vi
    .spyOn(ports, "getDeterministicFreePortBlock")
    .mockImplementation((options) =>
      (owner.getStore() === "second" ? secondPicker : firstPicker)(options),
    );
  const firstClaim = createDeferred();
  const releaseClaim = createDeferred();
  const secondProbe = createDeferred();
  const instances: Awaited<ReturnType<typeof createOpenClawTestInstance>>[] = [];
  let gatedClaim = false;
  let releaseProbe: (() => void) | undefined;
  const realpath = fs.realpath;
  const claimSpy = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
    if (owner.getStore() === "first" && !gatedClaim) {
      gatedClaim = true;
      firstClaim.resolve();
      await releaseClaim.promise;
    }
    return realpath(...args);
  });
  const probeSpy = vi.spyOn(net.Server.prototype, "close");
  const track = async (name: string) => {
    const instance = await createOpenClawTestInstance({ name });
    instances.push(instance);
    return instance;
  };
  const first = owner.run("first", () => track("overlap-first"));
  const firstResult = first.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  let second: ReturnType<typeof createOpenClawTestInstance> | undefined;
  try {
    await firstClaim.promise;
    probeSpy.mockImplementationOnce(function (this: net.Server, ...args) {
      releaseProbe = () => {
        releaseProbe = undefined;
        this.close(...args);
      };
      secondProbe.resolve();
      return this;
    });
    second = owner.run("second", () => track("overlap-second"));
    await secondProbe.promise;
    releaseClaim.resolve();
    const result = await firstResult;
    expect(result).not.toHaveProperty("error");
    releaseProbe!();
    const a = await first;
    const b = await second;
    expect(a.port).not.toBe(b.port);
  } finally {
    pickerSpy.mockRestore();
    claimSpy.mockRestore();
    probeSpy.mockRestore();
    releaseClaim.resolve();
    releaseProbe?.();
    await Promise.allSettled([first, second]);
    await Promise.all(instances.map((instance) => instance.cleanup()));
  }
});
