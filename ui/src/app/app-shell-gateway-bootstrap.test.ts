/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createProfileAppearanceGateway } from "./app-shell-gateway.test-support.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";

describe("ShellGatewayOwner display bootstrap", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    resetServerUiPrefsSync();
  });
  afterEach(() => {
    resetServerUiPrefsSync();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([true, false])(
    "waits for display bootstrap before falling back to editable config (available: %s)",
    async (available) => {
      const { context, owner, snapshot } = createProfileAppearanceGateway(null);
      const ready = createDeferred();
      Object.assign(context.runtimeConfig.state, { configSnapshot: null });
      vi.spyOn(context.config, "refresh").mockImplementationOnce(async () => {
        await ready.promise;
        Object.assign(context.runtimeConfig.state, {
          bootstrapConfig: available ? { ui: { prefs: {} } } : null,
        });
        return null;
      });
      const pending = owner.ensureRuntimeConfig(snapshot);
      expect(owner.ensureRuntimeConfig(snapshot)).toBe(pending);
      expect(context.runtimeConfig.ensureLoaded).not.toHaveBeenCalled();
      ready.resolve();
      await pending;
      expect(context.runtimeConfig.ensureLoaded).toHaveBeenCalledTimes(available ? 0 : 1);
    },
  );

  it("retires pending display bootstrap when the shell resets", async () => {
    const { context, owner, snapshot } = createProfileAppearanceGateway(null);
    const ready = createDeferred();
    Object.assign(context.runtimeConfig.state, { configSnapshot: null });
    vi.spyOn(context.config, "refresh").mockImplementationOnce(async () => {
      await ready.promise;
      return null;
    });
    const pending = owner.ensureRuntimeConfig(snapshot);
    owner.reset();
    ready.resolve();
    await pending;
    expect(context.runtimeConfig.ensureLoaded).not.toHaveBeenCalled();
  });
});
