import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "./plugin-install-path-warnings.js";

describe("plugin install path warnings", () => {
  it("ignores non-path installs and blank path candidates", async () => {
    expect(
      await detectPluginInstallPathIssue({
        pluginId: "matrix",
        install: null,
      }),
    ).toBeNull();
    expect(
      await detectPluginInstallPathIssue({
        pluginId: "matrix",
        install: {
          source: "npm",
          sourcePath: " ",
          installPath: " ",
        },
      }),
    ).toBeNull();
  });

  it("detects stale custom plugin install paths", async () => {
    const issue = await detectPluginInstallPathIssue({
      pluginId: "matrix",
      install: {
        source: "path",
        sourcePath: "/tmp/openclaw-matrix-missing",
        installPath: "/tmp/openclaw-matrix-missing",
      },
    });

    expect(issue).toEqual({
      kind: "missing-path",
      pluginId: "matrix",
      path: "/tmp/openclaw-matrix-missing",
    });
    expect(
      formatPluginInstallPathIssue({
        issue: issue!,
        pluginLabel: "Matrix",
        defaultInstallCommand: "openclaw plugins install @openclaw/matrix",
        repoInstallCommand: "openclaw plugins install ./extensions/matrix",
      }),
    ).toEqual([
      "Matrix is installed from a custom path that no longer exists: /tmp/openclaw-matrix-missing",
      'Reinstall with "openclaw plugins install @openclaw/matrix".',
      'If you are running from a repo checkout, you can also use "openclaw plugins install ./extensions/matrix".',
    ]);
  });

  it("uses the second candidate path when the first one is stale", async () => {
    await withTempHome(async (home) => {
      const pluginPath = path.join(home, "matrix-plugin");
      await fs.mkdir(pluginPath, { recursive: true });

      const issue = await detectPluginInstallPathIssue({
        pluginId: "matrix",
        install: {
          source: "path",
          sourcePath: "/tmp/openclaw-matrix-missing",
          installPath: pluginPath,
        },
      });

      expect(issue).toEqual({
        kind: "custom-path",
        pluginId: "matrix",
        path: pluginPath,
      });
    });
  });

  it("detects active custom plugin install paths", async () => {
    await withTempHome(async (home) => {
      const pluginPath = path.join(home, "matrix-plugin");
      await fs.mkdir(pluginPath, { recursive: true });

      const issue = await detectPluginInstallPathIssue({
        pluginId: "matrix",
        install: {
          source: "path",
          sourcePath: pluginPath,
          installPath: pluginPath,
        },
      });

      expect(issue).toEqual({
        kind: "custom-path",
        pluginId: "matrix",
        path: pluginPath,
      });
    });
  });

  it("applies custom command formatting in warning messages", () => {
    expect(
      formatPluginInstallPathIssue({
        issue: {
          kind: "custom-path",
          pluginId: "matrix",
          path: "/tmp/matrix-plugin",
        },
        pluginLabel: "Matrix",
        defaultInstallCommand: "openclaw plugins install @openclaw/matrix",
        repoInstallCommand: "openclaw plugins install ./extensions/matrix",
        formatCommand: (command) => `<${command}>`,
      }),
    ).toEqual([
      "Matrix is installed from a custom path: /tmp/matrix-plugin",
      "Main updates will not automatically replace that plugin with the repo's default Matrix package.",
      'Reinstall with "<openclaw plugins install @openclaw/matrix>" when you want to return to the standard Matrix plugin.',
      'If you are intentionally running from a repo checkout, reinstall that checkout explicitly with "<openclaw plugins install ./extensions/matrix>" after updates.',
    ]);
  });
});
