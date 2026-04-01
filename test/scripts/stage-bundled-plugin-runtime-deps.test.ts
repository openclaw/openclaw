import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stageBundledPluginRuntimeDeps } from "../../scripts/stage-bundled-plugin-runtime-deps.mjs";

describe("stageBundledPluginRuntimeDeps", () => {
  function createBundledPluginFixture(params: {
    packageJson: Record<string, unknown>;
    pluginId?: string;
  }) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-deps-"));
    const pluginId = params.pluginId ?? "fixture-plugin";
    const pluginDir = path.join(repoRoot, "dist", "extensions", pluginId);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      `${JSON.stringify(params.packageJson, null, 2)}\n`,
      "utf8",
    );
    return { pluginDir, repoRoot };
  }

  it("skips restaging when runtime deps stamp matches the sanitized manifest", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        peerDependencies: { openclaw: "^1.0.0" },
        peerDependenciesMeta: { openclaw: { optional: true } },
        devDependencies: { openclaw: "^1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const nodeModulesDir = path.join(pluginDir, "node_modules");
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.writeFileSync(path.join(nodeModulesDir, "marker.txt"), "present\n", "utf8");

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint }: { fingerprint: string }) => {
        installCount += 1;
        fs.writeFileSync(
          path.join(pluginDir, ".openclaw-runtime-deps-stamp.json"),
          `${JSON.stringify({ fingerprint }, null, 2)}\n`,
          "utf8",
        );
      },
    });
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: () => {
        installCount += 1;
      },
    });

    expect(installCount).toBe(1);
    expect(fs.existsSync(path.join(nodeModulesDir, "marker.txt"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"))).toEqual({
      name: "@openclaw/fixture-plugin",
      version: "1.0.0",
      dependencies: { "left-pad": "1.3.0" },
      openclaw: { bundle: { stageRuntimeDependencies: true } },
    });
  });

  it("restages when the manifest-owned runtime deps change", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });

    let installCount = 0;
    const stageOnce = () =>
      stageBundledPluginRuntimeDeps({
        cwd: repoRoot,
        installPluginRuntimeDepsImpl: ({ fingerprint }: { fingerprint: string }) => {
          installCount += 1;
          const nodeModulesDir = path.join(pluginDir, "node_modules");
          fs.mkdirSync(nodeModulesDir, { recursive: true });
          fs.writeFileSync(path.join(nodeModulesDir, "marker.txt"), `${installCount}\n`, "utf8");
          fs.writeFileSync(
            path.join(pluginDir, ".openclaw-runtime-deps-stamp.json"),
            `${JSON.stringify({ fingerprint }, null, 2)}\n`,
            "utf8",
          );
        },
      });

    stageOnce();
    const updatedPackageJson = JSON.parse(
      fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"),
    );
    updatedPackageJson.dependencies["is-odd"] = "3.0.1";
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      `${JSON.stringify(updatedPackageJson, null, 2)}\n`,
      "utf8",
    );
    stageOnce();

    expect(installCount).toBe(2);
    expect(fs.readFileSync(path.join(pluginDir, "node_modules", "marker.txt"), "utf8")).toBe("2\n");
  });

  it("stages runtime deps from the root node_modules when already installed", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const rootDepDir = path.join(repoRoot, "node_modules", "left-pad");
    fs.mkdirSync(rootDepDir, { recursive: true });
    fs.writeFileSync(path.join(rootDepDir, "package.json"), '{ "name": "left-pad" }\n', "utf8");
    fs.writeFileSync(path.join(rootDepDir, "index.js"), "module.exports = 1;\n", "utf8");

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "left-pad", "index.js"), "utf8"),
    ).toBe("module.exports = 1;\n");
    expect(fs.existsSync(path.join(pluginDir, ".openclaw-runtime-deps-stamp.json"))).toBe(true);
  });

  it("retries transient runtime dependency staging failures before surfacing an error", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint }: { fingerprint: string }) => {
        installCount += 1;
        if (installCount < 3) {
          throw new Error(`attempt ${installCount} failed`);
        }
        const nodeModulesDir = path.join(pluginDir, "node_modules");
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(path.join(nodeModulesDir, "marker.txt"), "ok\n", "utf8");
        fs.writeFileSync(
          path.join(pluginDir, ".openclaw-runtime-deps-stamp.json"),
          `${JSON.stringify({ fingerprint }, null, 2)}\n`,
          "utf8",
        );
      },
    });

    expect(installCount).toBe(3);
    expect(fs.readFileSync(path.join(pluginDir, "node_modules", "marker.txt"), "utf8")).toBe(
      "ok\n",
    );
  });

  it("surfaces the last staging error after exhausting retries", () => {
    const { repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });

    let installCount = 0;
    expect(() =>
      stageBundledPluginRuntimeDeps({
        cwd: repoRoot,
        installAttempts: 2,
        installPluginRuntimeDepsImpl: () => {
          installCount += 1;
          throw new Error(`attempt ${installCount} failed`);
        },
      }),
    ).toThrow("attempt 2 failed");
    expect(installCount).toBe(2);
  });
});
