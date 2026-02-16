import { describe, expect, it } from "vitest";
import { resolveLegacyDaemonCliAccessors } from "./daemon-cli-compat.js";

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

    expect(resolveLegacyDaemonCliAccessors(bundle)).toBeNull();
  });
});
