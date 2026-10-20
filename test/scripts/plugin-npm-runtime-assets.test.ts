import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as managedCommands from "../../scripts/lib/managed-child-process.mts";
import { buildPluginNpmRuntime } from "../../scripts/lib/plugin-npm-runtime-build.mts";
import { awaitGateBeforeSettlement, createDeferred } from "../helpers/promise.js";
import { writeJsonFile } from "../helpers/temp-repo.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

type AssetOptions = {
  tracked?: boolean;
  missing?: boolean;
  generated?: boolean;
  dependency?: string;
  localDependency?: boolean;
};
function createAssetFixture(options: AssetOptions = {}) {
  const repoRoot = createTempDir("openclaw-selected-plugin-assets-");
  const packageDir = path.join(repoRoot, "extensions", "demo");
  const source = options.dependency
    ? `node_modules/${options.dependency}/private/message.txt`
    : "assets/message.txt";
  fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
  const write = (file: string, value: string) =>
    fs.writeFileSync(path.join(packageDir, file), value);
  fs.writeFileSync(path.join(repoRoot, "package.json"), '{"name":"openclaw","version":"1.0.0"}');
  execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
  writeJsonFile(path.join(packageDir, "package.json"), {
    name: "@fixture/demo",
    version: "1.0.0",
    type: "module",
    ...(options.dependency ? { dependencies: { [options.dependency]: "1.0.0" } } : {}),
    openclaw: {
      extensions: ["./index.ts"],
      build: {
        runtimeFormat: "esm",
        staticAssets: [{ source: `./${source}`, output: "assets/message.txt" }],
      },
      ...(options.generated ? { assetScripts: { build: "node build-assets.cjs" } } : {}),
    },
  });
  write("openclaw.plugin.json", '{"id":"demo"}');
  write(
    "index.ts",
    'import { readFileSync } from "node:fs"; export const message = readFileSync(new URL("./assets/message.txt", import.meta.url), "utf8");',
  );
  if (options.dependency) {
    for (const base of options.localDependency ? [repoRoot, packageDir] : [repoRoot]) {
      const dependencyDir = path.join(base, "node_modules", options.dependency);
      writeJsonFile(path.join(dependencyDir, "package.json"), {
        name: options.dependency,
        exports: { "./message": "./private/message.txt" },
      });
      fs.mkdirSync(path.join(dependencyDir, "private"), { recursive: true });
      if (!(options.missing && base === packageDir)) {
        fs.writeFileSync(
          path.join(dependencyDir, "private/message.txt"),
          options.localDependency && base === repoRoot
            ? "wrong ancestor version"
            : "selected asset",
        );
      }
    }
  } else if (options.generated) {
    write(
      "build-assets.cjs",
      'require("node:fs").writeFileSync("assets/message.txt", "selected asset");',
    );
  } else if (!options.missing) {
    write("assets/message.txt", "selected asset");
  }
  if (options.tracked) {
    execFileSync("git", ["add", "extensions/demo/package.json"], { cwd: repoRoot });
  }
  return { repoRoot, packageDir, source, write, logLevel: "silent" as const };
}

describe("selected plugin runtime assets", () => {
  it("builds package assets against the packed tree's tsconfig, not release tooling's", async () => {
    const fixture = createAssetFixture({ generated: true });
    fixture.write(fixture.source, "selected asset");
    vi.stubEnv("TSX_TSCONFIG_PATH", "/release-tooling/tsconfig.json");
    const runner = vi.spyOn(managedCommands, "runManagedCommand").mockResolvedValueOnce(0);
    try {
      await buildPluginNpmRuntime(fixture);
      const env = runner.mock.calls[0]?.[0].env;
      expect(env).toBeDefined();
      expect(env).not.toHaveProperty("TSX_TSCONFIG_PATH");
      expect(env?.PATH).toBe(process.env.PATH);
    } finally {
      runner.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("awaits bounded asset execution before publishing package assets", async () => {
    const fixture = createAssetFixture({ generated: true });
    fixture.write(fixture.source, "previous source asset");
    const started = createDeferred<Parameters<typeof managedCommands.runManagedCommand>[0]>();
    const command = createDeferred<number>();
    const runner = vi
      .spyOn(managedCommands, "runManagedCommand")
      .mockImplementationOnce((options) => {
        started.resolve(options);
        return command.promise;
      });
    const building = buildPluginNpmRuntime(fixture);
    const built = building.catch((error: unknown) => error);
    try {
      const options = await awaitGateBeforeSettlement(
        started.promise,
        building,
        "Package builder completed without bounded asset execution",
      );
      expect(options.timeoutMs).toBe(600_000);
      expect(options.requireProcessTreeExit).toBe(process.platform !== "win32");
      const output = path.join(fixture.packageDir, "dist/assets/message.txt");
      expect(fs.existsSync(output)).toBe(false);
      const failure = Object.assign(new Error("joined asset timeout"), {
        code: "ETIMEDOUT",
        processTreeState: "terminated",
      });
      command.reject(failure);
      expect(await built).toMatchObject({
        code: "ETIMEDOUT",
        message: "Plugin asset build hook timed out after 600000ms: demo",
        cause: failure,
      });
      expect(fs.existsSync(output)).toBe(false);
      expect(fs.readFileSync(path.join(fixture.packageDir, fixture.source), "utf8")).toBe(
        "previous source asset",
      );
    } finally {
      command.resolve(0);
      await built;
      runner.mockRestore();
    }
  });

  it.each([
    ["untracked package", {}],
    ["tracked package with a malformed unrelated manifest", { tracked: true }],
    ["asset generated after compilation", { generated: true }],
    ["hoisted dependency", { dependency: "engine" }],
    ["hoisted scoped dependency", { dependency: "@fixture/engine" }],
    [
      "plugin-local dependency before hoisted version",
      { dependency: "@fixture/engine", localDependency: true },
    ],
  ] satisfies [string, AssetOptions][])("builds loadable assets for %s", async (_, options) => {
    const fixture = createAssetFixture(options);
    if (options.tracked) {
      const other = path.join(fixture.repoRoot, "extensions", "other");
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, "package.json"), "{");
      execFileSync("git", ["add", "extensions/other/package.json"], { cwd: fixture.repoRoot });
    }

    writeJsonFile(path.join(fixture.packageDir, "openclaw.plugin.json"), {
      id: "demo",
      themes: [
        {
          id: "mission",
          name: "Mission",
          description: "Mission theme",
          source: "theme.json",
          icons: { rocket: "assets/rocket.svg" },
        },
      ],
    });
    fixture.write("theme.json", "{}");
    fixture.write("assets/rocket.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const result = await buildPluginNpmRuntime(fixture);
    expect(result?.packageFiles).toEqual(
      expect.arrayContaining(["theme.json", "assets/rocket.svg"]),
    );
    expect(result?.copiedStaticAssets).toEqual(["dist/assets/message.txt"]);
    const entry = pathToFileURL(path.join(fixture.packageDir, "dist", "index.js")).href;
    expect(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `process.stdout.write((await import(${JSON.stringify(entry)})).message);`,
        ],
        { encoding: "utf8" },
      ),
    ).toBe("selected asset");
  });

  it.each([
    ["package-relative file", {}],
    [
      "local dependency asset despite an ancestor version containing it",
      { dependency: "@fixture/engine", localDependency: true },
    ],
  ] satisfies [string, AssetOptions][])(
    "reports a missing %s instead of publishing an incomplete package",
    async (_, options) => {
      const fixture = createAssetFixture({ ...options, tracked: true, missing: true });
      await expect(buildPluginNpmRuntime(fixture)).rejects.toThrow(
        `demo missing static asset source(s): extensions/demo/${fixture.source}`,
      );
    },
  );
});
