import { afterEach, expect, it, vi } from "vitest";

const standalone = vi.hoisted(() => ({ value: false }));
vi.mock("../../cli-invocation.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cli-invocation.mjs")>()),
  isStandaloneRuntimeExecutable: () => standalone.value,
}));

const {
  BUNDLED_PLUGIN_DEV_RELOAD_ENV,
  resolveBundledCodeReloadPluginIds,
  resolveBundledPluginDevReloadMode,
} = await import("./bundled-plugin-dev-reload.js");

afterEach(() => {
  standalone.value = false;
  vi.unstubAllEnvs();
});

it("keeps bundled code host-owned unless the operator opts in", () => {
  expect(resolveBundledPluginDevReloadMode({})).toEqual({ enabled: false });
  expect(resolveBundledPluginDevReloadMode({ [BUNDLED_PLUGIN_DEV_RELOAD_ENV]: "0" })).toEqual({
    enabled: false,
  });
  expect(resolveBundledPluginDevReloadMode({ [BUNDLED_PLUGIN_DEV_RELOAD_ENV]: "1" })).toEqual({
    enabled: true,
  });
});

it("ignores the opt-in in standalone executables with a visible warning", () => {
  standalone.value = true;
  expect(resolveBundledPluginDevReloadMode({ [BUNDLED_PLUGIN_DEV_RELOAD_ENV]: "1" })).toEqual({
    enabled: false,
    ignoredWarning: expect.stringContaining("embedded in this executable"),
  });
  expect(resolveBundledPluginDevReloadMode({})).toEqual({ enabled: false });
});

it("limits opted-in recapture to explicit reload targets", () => {
  const reload = { reason: "reload", pluginIds: ["knowledge"] };
  vi.stubEnv(BUNDLED_PLUGIN_DEV_RELOAD_ENV, "1");
  expect(resolveBundledCodeReloadPluginIds(reload)).toEqual(["knowledge"]);
  expect(resolveBundledCodeReloadPluginIds({ ...reload, reason: "enable" })).toBeUndefined();
  expect(resolveBundledCodeReloadPluginIds(undefined)).toBeUndefined();
  standalone.value = true;
  expect(resolveBundledCodeReloadPluginIds(reload)).toBeUndefined();
});
