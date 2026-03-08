import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const rootSdk = require("./root-alias.cjs") as Record<string, unknown>;

type EmptySchema = {
  safeParse: (value: unknown) =>
    | { success: true; data?: unknown }
    | {
        success: false;
        error: { issues: Array<{ path: Array<string | number>; message: string }> };
      };
};

type RootAliasTestHooks = {
  __unsafeIsMonolithicLoadedForTest?: () => boolean;
  __unsafeResetMonolithicForTest?: () => void;
  __unsafeSetJitiOverrideForTest?: (loader: (modulePath: string) => unknown) => void;
};

describe("plugin-sdk root alias", () => {
  it("exposes the fast empty config schema helper", () => {
    const factory = rootSdk.emptyPluginConfigSchema as (() => EmptySchema) | undefined;
    expect(typeof factory).toBe("function");
    if (!factory) {
      return;
    }
    const schema = factory();
    expect(schema.safeParse(undefined)).toEqual({ success: true, data: undefined });
    expect(schema.safeParse({})).toEqual({ success: true, data: {} });
    const parsed = schema.safeParse({ invalid: true });
    expect(parsed.success).toBe(false);
  });

  it("loads legacy root exports lazily through the proxy", { timeout: 240_000 }, () => {
    expect(typeof rootSdk.resolveControlCommandGate).toBe("function");
    expect(typeof rootSdk.default).toBe("object");
    expect(rootSdk.default).toBe(rootSdk);
    expect(rootSdk.__esModule).toBe(true);
  });

  it("keeps fast legacy export resolution off the monolithic SDK path", () => {
    const hooks = rootSdk as RootAliasTestHooks;
    expect(typeof hooks.__unsafeIsMonolithicLoadedForTest).toBe("function");
    expect(hooks.__unsafeIsMonolithicLoadedForTest?.()).toBe(false);

    expect(typeof rootSdk.resolveControlCommandGate).toBe("function");

    expect(hooks.__unsafeIsMonolithicLoadedForTest?.()).toBe(false);
  });

  it("propagates monolithic loader failures for non-fast exports", () => {
    const hooks = rootSdk as RootAliasTestHooks;
    hooks.__unsafeResetMonolithicForTest?.();
    hooks.__unsafeSetJitiOverrideForTest?.(() => {
      throw new Error("forced-monolithic-load-failure");
    });

    expect(() => rootSdk.registerPluginHttpRoute).toThrow("forced-monolithic-load-failure");

    hooks.__unsafeResetMonolithicForTest?.();
  });

  it("keeps `in` capability probes non-throwing when monolithic load fails", () => {
    const hooks = rootSdk as RootAliasTestHooks;
    hooks.__unsafeResetMonolithicForTest?.();
    hooks.__unsafeSetJitiOverrideForTest?.(() => {
      throw new Error("forced-monolithic-load-failure");
    });

    expect(() => "registerPluginHttpRoute" in rootSdk).not.toThrow();
    expect("registerPluginHttpRoute" in rootSdk).toBe(false);

    hooks.__unsafeResetMonolithicForTest?.();
  });

  it("keeps descriptor capability probes non-throwing when monolithic load fails", () => {
    const hooks = rootSdk as RootAliasTestHooks;
    hooks.__unsafeResetMonolithicForTest?.();
    hooks.__unsafeSetJitiOverrideForTest?.(() => {
      throw new Error("forced-monolithic-load-failure");
    });

    expect(() =>
      Object.prototype.hasOwnProperty.call(rootSdk, "registerPluginHttpRoute"),
    ).not.toThrow();
    expect(Object.prototype.hasOwnProperty.call(rootSdk, "registerPluginHttpRoute")).toBe(false);

    hooks.__unsafeResetMonolithicForTest?.();
  });

  it("preserves reflection semantics for lazily resolved exports", { timeout: 240_000 }, () => {
    expect("resolveControlCommandGate" in rootSdk).toBe(true);
    const keys = Object.keys(rootSdk);
    expect(keys).toContain("resolveControlCommandGate");
    const descriptor = Object.getOwnPropertyDescriptor(rootSdk, "resolveControlCommandGate");
    expect(descriptor).toBeDefined();
  });
});
