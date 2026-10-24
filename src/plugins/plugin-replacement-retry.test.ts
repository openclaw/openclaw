import { describe, expect, it, vi } from "vitest";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { pluginInvocationContext } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { isPluginReloadingError, retryAfterPluginReplacement } from "./plugin-replacement-retry.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRecord } from "./status.test-helpers.js";

function createOwnedInstance(id = "swap") {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id });
  registry.plugins.push(record);
  return new PluginInstance(record.id, { record, registry });
}

function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to be refused");
}

describe("plugin calls during a replacement", () => {
  it("lets a fresh host call refused after quiesce wait for the reservation", async () => {
    const instance = createOwnedInstance();
    const release = instance.reserveReplacement();
    instance.quiesce();

    const error = refusal(() => instance.run(() => "old"));
    expect(isPluginReloadingError(error)).toBe(true);
    const settled = vi.fn();
    void (error as PluginInstanceUnavailableError).replacement?.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    release();
    await (error as PluginInstanceUnavailableError).replacement;
    expect(settled).toHaveBeenCalledOnce();
  });

  it("admits calls and retained consumers while the reload still drains retained work", () => {
    const instance = createOwnedInstance();
    instance.reserveReplacement();

    expect(instance.run(() => "admitted")).toBe("admitted");
    instance.retainConsumer().release();
  });

  it("offers retained-consumer acquisition the same wait after quiesce", () => {
    const instance = createOwnedInstance();
    instance.reserveReplacement();
    instance.quiesce();

    expect(isPluginReloadingError(refusal(() => instance.retainConsumer()))).toBe(true);
  });

  it("refuses without a wait when no reload holds a reservation", () => {
    const instance = createOwnedInstance();
    instance.quiesce();

    const error = refusal(() => instance.run(() => "old"));
    expect(error).toBeInstanceOf(PluginInstanceUnavailableError);
    expect(isPluginReloadingError(error)).toBe(false);
  });

  it("refuses without a wait from plugin code, which the drain may be waiting on", () => {
    const caller = createOwnedInstance("caller");
    const target = createOwnedInstance("target");
    target.reserveReplacement();
    target.quiesce();

    const error = caller.run(() => refusal(() => target.run(() => "nested")));
    expect(error).toBeInstanceOf(PluginInstanceUnavailableError);
    expect(isPluginReloadingError(error)).toBe(false);
  });

  it("refuses without a wait from work the pending drain is joining", () => {
    const instance = createOwnedInstance();
    instance.reserveReplacement();
    instance.quiesce();

    const error = pluginInvocationContext.run(
      { holdsPendingReplacement: true, lookup: () => undefined },
      () => refusal(() => instance.run(() => "held")),
    );
    expect(isPluginReloadingError(error)).toBe(false);
  });

  it("resolves the call once more after the reload settles", async () => {
    const previous = createOwnedInstance();
    const current = createOwnedInstance();
    const release = previous.reserveReplacement();
    previous.quiesce();
    let published = previous;
    const run = vi.fn(() => published.run(() => published));

    const result = retryAfterPluginReplacement(run);
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
    published = current;
    release();

    await expect(result).resolves.toBe(current);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("returns the second refusal when another reload refuses the retry", async () => {
    const instance = createOwnedInstance();
    const release = instance.reserveReplacement();
    instance.quiesce();
    const result = retryAfterPluginReplacement(() => {
      const error = refusal(() => instance.run(() => "old"));
      throw error;
    });

    release();
    instance.reserveReplacement();
    await expect(result).rejects.toSatisfy(isPluginReloadingError);
  });
});
