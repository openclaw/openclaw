import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { repoInstallSpec } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "./plugin-install-path-warnings.js";

const MATRIX_REPO_INSTALL_COMMAND = `openclaw plugins install ${repoInstallSpec("matrix")}`;
const missingPath = "/tmp/openclaw-matrix-missing";
const detect = (sourcePath: string, installPath = sourcePath) =>
  detectPluginInstallPathIssue({
    pluginId: "matrix",
    install: { source: "path", sourcePath, installPath },
  });
const format = (
  issue: Parameters<typeof formatPluginInstallPathIssue>[0]["issue"],
  options: Partial<Parameters<typeof formatPluginInstallPathIssue>[0]> = {},
) =>
  formatPluginInstallPathIssue({
    issue,
    pluginLabel: "Matrix",
    defaultInstallCommand: "openclaw plugins install @openclaw/matrix",
    repoInstallCommand: MATRIX_REPO_INSTALL_COMMAND,
    ...options,
  });

describe("plugin install path warnings", () => {
  it.each([null, { source: "npm", sourcePath: " ", installPath: " " }] as const)(
    "ignores non-path install %j",
    async (install) => {
      expect(await detectPluginInstallPathIssue({ pluginId: "matrix", install })).toBeNull();
    },
  );

  it("detects stale custom plugin install paths", async () => {
    const issue = await detect(missingPath);
    expect(issue).toEqual({
      kind: "missing-path",
      pluginId: "matrix",
      path: "/tmp/openclaw-matrix-missing",
    });
    expect(format(issue!)).toEqual([
      "Matrix is installed from a custom path that no longer exists: /tmp/openclaw-matrix-missing",
      'Reinstall with "openclaw plugins install @openclaw/matrix".',
      `If you are running from a repo checkout, you can also use "${MATRIX_REPO_INSTALL_COMMAND}".`,
    ]);
  });

  it.each([false, true])("detects active paths with a stale first candidate: %s", async (stale) => {
    await withTempHome(async (home) => {
      const pluginPath = path.join(home, "matrix-plugin");
      await fs.mkdir(pluginPath, { recursive: true });
      expect(await detect(stale ? missingPath : pluginPath, pluginPath)).toEqual({
        kind: "custom-path",
        pluginId: "matrix",
        path: pluginPath,
      });
    });
  });

  it("applies custom command formatting in warning messages", () => {
    expect(
      format(
        { kind: "custom-path", pluginId: "matrix", path: "/tmp/matrix-plugin" },
        { formatCommand: (command) => `<${command}>` },
      ),
    ).toEqual([
      "Matrix is installed from a custom path: /tmp/matrix-plugin",
      "Main updates will not automatically replace that plugin with the repo's default Matrix package.",
      'Reinstall with "<openclaw plugins install @openclaw/matrix>" when you want to return to the standard Matrix plugin.',
      `If you are intentionally running from a repo checkout, reinstall that checkout explicitly with "<${MATRIX_REPO_INSTALL_COMMAND}>" after updates.`,
    ]);
  });

  it("omits repo checkout guidance when no bundled source hint exists", () => {
    expect(
      format(
        { kind: "missing-path", pluginId: "matrix", path: missingPath },
        { repoInstallCommand: null },
      ),
    ).toEqual([
      "Matrix is installed from a custom path that no longer exists: /tmp/openclaw-matrix-missing",
      'Reinstall with "openclaw plugins install @openclaw/matrix".',
    ]);
  });
});
