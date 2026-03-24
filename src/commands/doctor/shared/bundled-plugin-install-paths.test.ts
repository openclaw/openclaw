import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectBundledPluginInstallPathWarnings,
  maybeRepairBundledPluginInstallPaths,
  scanBundledPluginInstallPathRepairs,
} from "./bundled-plugin-install-paths.js";

describe("doctor bundled plugin install path repair", () => {
  it("repairs stale bundled install records and load paths", () => {
    const stalePath = "/pkg/extensions/acpx";
    const nextPath = "/pkg/dist/extensions/acpx";
    const bundledSources = new Map([
      [
        "acpx",
        {
          pluginId: "acpx",
          localPath: nextPath,
        },
      ],
    ]);

    const hits = scanBundledPluginInstallPathRepairs(
      {
        plugins: {
          load: { paths: [stalePath] },
          installs: {
            acpx: {
              source: "path",
              spec: "acpx",
              sourcePath: stalePath,
              installPath: stalePath,
            },
          },
        },
      },
      {
        bundledSources,
        pathExists: (candidatePath) => candidatePath === nextPath,
      },
    );

    expect(hits).toEqual([
      {
        pluginId: "acpx",
        nextPath,
        installFieldHits: [
          { field: "sourcePath", previousPath: stalePath },
          { field: "installPath", previousPath: stalePath },
        ],
        loadPathHits: [{ index: 0, previousPath: stalePath }],
      },
    ]);

    const repaired = maybeRepairBundledPluginInstallPaths(
      {
        plugins: {
          load: { paths: [stalePath] },
          installs: {
            acpx: {
              source: "path",
              spec: "acpx",
              sourcePath: stalePath,
              installPath: stalePath,
            },
          },
        },
      },
      {
        bundledSources,
        pathExists: (candidatePath) => candidatePath === nextPath,
      },
    );

    expect(repaired.config.plugins?.load?.paths).toEqual([nextPath]);
    expect(repaired.config.plugins?.installs?.acpx).toMatchObject({
      source: "path",
      spec: "acpx",
      sourcePath: nextPath,
      installPath: nextPath,
    });
    expect(repaired.changes).toEqual([
      `- plugins.installs.acpx.sourcePath: updated stale bundled path from ${stalePath} -> ${nextPath}`,
      `- plugins.installs.acpx.installPath: updated stale bundled path from ${stalePath} -> ${nextPath}`,
      `- plugins.load.paths[0]: updated stale bundled path from ${stalePath} -> ${nextPath}`,
    ]);

    const warnings = collectBundledPluginInstallPathWarnings({
      hits,
      doctorFixCommand: "openclaw doctor --fix",
    });
    expect(warnings).toEqual([
      expect.stringContaining(`Bundled plugin "acpx" now resolves to ${nextPath}`),
    ]);
    expect(warnings[0]).toContain(`plugins.installs.acpx.sourcePath: ${stalePath}`);
    expect(warnings[0]).toContain(`plugins.load.paths[0]: ${stalePath}`);
    expect(warnings[0]).toContain('Run "openclaw doctor --fix"');
  });

  it("does not rewrite missing custom paths outside the current package root", () => {
    const hits = scanBundledPluginInstallPathRepairs(
      {
        plugins: {
          load: { paths: ["/workspace/custom-plugins/acpx"] },
          installs: {
            acpx: {
              source: "path",
              spec: "acpx",
              sourcePath: "/workspace/custom-plugins/acpx",
              installPath: "/workspace/custom-plugins/acpx",
            },
          },
        },
      },
      {
        bundledSources: new Map([
          [
            "acpx",
            {
              pluginId: "acpx",
              localPath: "/pkg/dist/extensions/acpx",
            },
          ],
        ]),
        pathExists: () => false,
      },
    );

    expect(hits).toEqual([]);
  });

  it("repairs only install fields that were flagged as stale", () => {
    const stalePath = "/pkg/extensions/acpx";
    const customInstallPath = "/custom/missing/acpx";
    const nextPath = "/pkg/dist/extensions/acpx";

    const hits = scanBundledPluginInstallPathRepairs(
      {
        plugins: {
          installs: {
            acpx: {
              source: "path",
              spec: "acpx",
              sourcePath: stalePath,
              installPath: customInstallPath,
            },
          },
        },
      },
      {
        bundledSources: new Map([
          [
            "acpx",
            {
              pluginId: "acpx",
              localPath: nextPath,
            },
          ],
        ]),
        pathExists: (candidatePath) => candidatePath === nextPath,
      },
    );

    expect(hits).toEqual([
      {
        pluginId: "acpx",
        nextPath,
        installFieldHits: [{ field: "sourcePath", previousPath: stalePath }],
        loadPathHits: [],
      },
    ]);

    const repaired = maybeRepairBundledPluginInstallPaths(
      {
        plugins: {
          installs: {
            acpx: {
              source: "path",
              spec: "acpx",
              sourcePath: stalePath,
              installPath: customInstallPath,
            },
          },
        },
      },
      {
        bundledSources: new Map([
          [
            "acpx",
            {
              pluginId: "acpx",
              localPath: nextPath,
            },
          ],
        ]),
        pathExists: (candidatePath) => candidatePath === nextPath,
      },
    );

    expect(repaired.config.plugins?.installs?.acpx).toMatchObject({
      source: "path",
      spec: "acpx",
      sourcePath: nextPath,
      installPath: customInstallPath,
    });
    expect(repaired.changes).toEqual([
      `- plugins.installs.acpx.sourcePath: updated stale bundled path from ${stalePath} -> ${nextPath}`,
    ]);
  });

  it("repairs stale bundled paths when config and discovery use symlinked package roots", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-paths-"));
    const realPkgRoot = path.join(tempRoot, "real", "pkg");
    const aliasRoot = path.join(tempRoot, "alias");
    const bundledPath = path.join(realPkgRoot, "dist", "extensions", "acpx");
    const stalePath = path.join(aliasRoot, "pkg", "extensions", "acpx");

    fs.mkdirSync(path.dirname(bundledPath), { recursive: true });
    fs.symlinkSync(path.join(tempRoot, "real"), aliasRoot, "dir");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });

    try {
      const hits = scanBundledPluginInstallPathRepairs(
        {
          plugins: {
            load: { paths: [stalePath] },
            installs: {
              acpx: {
                source: "path",
                spec: "acpx",
                sourcePath: stalePath,
                installPath: stalePath,
              },
            },
          },
        },
        {
          bundledSources: new Map([
            [
              "acpx",
              {
                pluginId: "acpx",
                localPath: bundledPath,
              },
            ],
          ]),
          pathExists: (candidatePath) => candidatePath === bundledPath,
        },
      );

      expect(hits).toEqual([
        {
          pluginId: "acpx",
          nextPath: bundledPath,
          installFieldHits: [
            { field: "sourcePath", previousPath: stalePath },
            { field: "installPath", previousPath: stalePath },
          ],
          loadPathHits: [{ index: 0, previousPath: stalePath }],
        },
      ]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
