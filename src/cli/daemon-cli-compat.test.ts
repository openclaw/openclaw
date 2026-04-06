import { describe, expect, it } from "vitest";
import {
  resolveAliasedExportAccessor,
  resolveLegacyDaemonCliAccessors,
  resolveLegacyDaemonCliRegisterAccessor,
} from "./daemon-cli-compat.js";

describe("resolveLegacyDaemonCliAccessors", () => {
  it("resolves aliased daemon-cli exports from a bundled chunk", () => {
    const bundle = `
      var daemon_cli_exports = /* @__PURE__ */ __exportAll({ registerDaemonCli: () => registerDaemonCli });
      export { runDaemonStop as a, runDaemonStart as i, runDaemonStatus as n, runDaemonUninstall as o, runDaemonRestart as r, runDaemonInstall as s, daemon_cli_exports as t };
    `;

    expect(resolveLegacyDaemonCliAccessors(bundle)).toEqual({
      registerDaemonCli: "t.registerDaemonCli",
      runDaemonInstall: "s",
      runDaemonRestart: "r",
      runDaemonStart: "i",
      runDaemonStatus: "n",
      runDaemonStop: "a",
      runDaemonUninstall: "o",
    });
  });

  it("returns null when required aliases are missing", () => {
    const bundle = `
      var daemon_cli_exports = /* @__PURE__ */ __exportAll({ registerDaemonCli: () => registerDaemonCli });
      export { runDaemonRestart as r, daemon_cli_exports as t };
    `;

    expect(resolveLegacyDaemonCliAccessors(bundle)).toEqual({
      registerDaemonCli: "t.registerDaemonCli",
      runDaemonRestart: "r",
    });
  });

  it("returns null when the required restart alias is missing", () => {
    const bundle = `
      var daemon_cli_exports = /* @__PURE__ */ __exportAll({ registerDaemonCli: () => registerDaemonCli });
      export { daemon_cli_exports as t };
    `;

    expect(resolveLegacyDaemonCliAccessors(bundle)).toBeNull();
  });

  it("resolves the register accessor even when daemon actions are split into other bundles", () => {
    const bundle = `
      export { registerDaemonCli as t };
    `;

    expect(resolveLegacyDaemonCliRegisterAccessor(bundle)).toBe("t");
  });

  it("resolves a direct aliased export accessor from a non-daemon helper bundle", () => {
    const bundle = `
      export { runDaemonInstall as a, runDaemonRestart as t };
    `;

    expect(resolveAliasedExportAccessor(bundle, "runDaemonRestart")).toBe("t");
    expect(resolveAliasedExportAccessor(bundle, "runDaemonInstall")).toBe("a");
    expect(resolveAliasedExportAccessor(bundle, "runDaemonStatus")).toBeNull();
  });
});
