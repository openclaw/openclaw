import { describe, expect, it, vi } from "vitest";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";

describe("plugin runtime capability lease revoke", () => {
  it("runs every retained cleanup and rethrows a single failure", () => {
    const lease = createPluginRuntimeCapabilityLease("test plugin");
    const failure = new Error("cleanup failed");
    const first = vi.fn(() => {
      throw failure;
    });
    const second = vi.fn();
    lease.retain(first);
    lease.retain(second);

    expect(() => lease.revoke()).toThrow(failure);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(lease.isActive()).toBe(false);
    expect(() => lease.revoke()).not.toThrow();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("aggregates failures when several cleanups throw", () => {
    const lease = createPluginRuntimeCapabilityLease("test plugin");
    const firstError = new Error("first failed");
    const thirdError = new Error("third failed");
    const last = vi.fn();
    lease.retain(() => {
      throw firstError;
    });
    lease.retain(vi.fn());
    lease.retain(() => {
      throw thirdError;
    });
    lease.retain(last);

    let thrown: unknown;
    try {
      lease.revoke();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([firstError, thirdError]);
    expect(last).toHaveBeenCalledTimes(1);
  });

  it("does not run a cleanup again after its release handle was used", () => {
    const lease = createPluginRuntimeCapabilityLease("test plugin");
    const cleanup = vi.fn();
    const release = lease.retain(cleanup);

    release();
    lease.revoke();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
