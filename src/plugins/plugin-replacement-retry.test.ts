import { describe, expect, it, vi } from "vitest";
import { captureThrown } from "../../test/helpers/capture-thrown.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { pluginInvocationContext } from "./plugin-instance-scope.js";
import { createOwnedTestInstance as createOwnedInstance } from "./plugin-instance.test-support.js";
import { isPluginReloadingError, retryAfterPluginReplacement } from "./plugin-replacement-retry.js";

function refusal(run: () => unknown): unknown {
  return captureThrown(run, "expected the call to be refused");
}

describe("plugin calls during a replacement", () => {
  it.each(["call", "consumer"])("lets a fresh host %s wait after quiesce", async (kind) => {
    const instance = createOwnedInstance("swap");
    const release = instance.reserveReplacement();
    expect(instance.run(() => "admitted")).toBe("admitted");
    instance.retainConsumer().release();
    instance.quiesce();

    const error = refusal(() =>
      kind === "call" ? instance.run(() => "old") : instance.retainConsumer(),
    );
    expect(isPluginReloadingError(error)).toBe(true);
    const settled = vi.fn();
    void (error as PluginInstanceUnavailableError).replacement?.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    release();
    await (error as PluginInstanceUnavailableError).replacement;
    expect(settled).toHaveBeenCalledOnce();
  });

  it.each(["no reservation", "plugin code", "retained work"])(
    "refuses without a wait: %s",
    (scope) => {
      const instance = createOwnedInstance("swap");
      if (scope !== "no reservation") {
        instance.reserveReplacement();
      }
      instance.quiesce();
      const invoke = () => refusal(() => instance.run(() => "old"));
      const error =
        scope === "plugin code"
          ? createOwnedInstance("caller").run(invoke)
          : scope === "retained work"
            ? pluginInvocationContext.run(
                { holdsPendingReplacement: true, lookup: () => undefined },
                invoke,
              )
            : invoke();
      expect(error).toBeInstanceOf(PluginInstanceUnavailableError);
      expect(isPluginReloadingError(error)).toBe(false);
    },
  );

  it.each([false, true])(
    "resolves a fresh target once after reload; retry refused=%s",
    async (refused) => {
      const previous = createOwnedInstance("swap");
      const current = createOwnedInstance("swap");
      const release = previous.reserveReplacement();
      previous.quiesce();
      let published = previous;
      const run = vi.fn(() => published.run(() => published));
      const result = retryAfterPluginReplacement(run);
      expect(run).toHaveBeenCalledOnce();

      published = refused ? previous : current;
      release();
      if (refused) {
        previous.reserveReplacement();
        await expect(result).rejects.toSatisfy(isPluginReloadingError);
      } else {
        await expect(result).resolves.toBe(current);
      }
      expect(run).toHaveBeenCalledTimes(2);
    },
  );
});
