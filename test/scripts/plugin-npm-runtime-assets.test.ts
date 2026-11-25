import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import * as managedCommands from "../../scripts/lib/managed-child-process.mts";
import { buildPluginNpmRuntime } from "../../scripts/lib/plugin-npm-runtime-build.mts";
import { awaitGateBeforeSettlement, createDeferred } from "../helpers/promise.js";
import { writeJsonFile } from "../helpers/temp-repo.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type AssetOptions = {
  tracked?: boolean;
  missing?: boolean;
  generated?: boolean;
  dependency?: string;
  localDependency?: boolean;
};
function createAssetFixture(options: AssetOptions = {}) {
  const { dependency, localDependency, generated, missing, tracked } = options;
  const repoRoot = createTempDir("openclaw-selected-plugin-assets-");
  const packageDir = path.join(repoRoot, "extensions", "demo");
  const source = dependency
    ? `node_modules/${dependency}/private/message.txt`
    : "assets/message.txt";
  fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
  const file = (name: string) => path.join(packageDir, name);
  const write = (name: string, value = "selected asset") => fs.writeFileSync(file(name), value);
  fs.writeFileSync(path.join(repoRoot, "package.json"), '{"name":"openclaw","version":"1.0.0"}');
  execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
  writeJsonFile(file("package.json"), {
    name: "@fixture/demo",
    version: "1.0.0",
    type: "module",
    ...(dependency ? { dependencies: { [dependency]: "1.0.0" } } : {}),
    openclaw: {
      extensions: ["./index.ts"],
      build: {
        runtimeFormat: "esm",
        staticAssets: [{ source: `./${source}`, output: "assets/message.txt" }],
      },
      ...(generated ? { assetScripts: { build: "node build-assets.cjs" } } : {}),
    },
  });
  write("openclaw.plugin.json", '{"id":"demo"}');
  write(
    "index.ts",
    'import { readFileSync } from "node:fs"; export const message = readFileSync(new URL("./assets/message.txt", import.meta.url), "utf8");',
  );
  if (dependency) {
    for (const base of localDependency ? [repoRoot, packageDir] : [repoRoot]) {
      const dependencyDir = path.join(base, "node_modules", dependency);
      writeJsonFile(path.join(dependencyDir, "package.json"), {
        name: dependency,
        exports: { "./message": "./private/message.txt" },
      });
      fs.mkdirSync(path.join(dependencyDir, "private"), { recursive: true });
      if (!(missing && base === packageDir)) {
        fs.writeFileSync(
          path.join(dependencyDir, "private/message.txt"),
          localDependency && base === repoRoot ? "wrong ancestor version" : "selected asset",
        );
      }
    }
  } else if (generated) {
    write(
      "build-assets.cjs",
      'require("node:fs").writeFileSync("assets/message.txt", "selected asset");',
    );
  } else if (!missing) {
    write("assets/message.txt");
  }
  if (tracked) {
    execFileSync("git", ["add", "extensions/demo/package.json"], { cwd: repoRoot });
  }
  return { repoRoot, packageDir, source, file, write, logLevel: "silent" as const };
}

it("isolates and awaits bounded asset hooks before publishing package assets", async () => {
  const fixture = createAssetFixture({ generated: true });
  fixture.write(fixture.source, "previous source asset");
  vi.stubEnv("TSX_TSCONFIG_PATH", "/release-tooling/tsconfig.json");
  const started = createDeferred<Parameters<typeof managedCommands.runManagedCommand>[0]>();
  const command = createDeferred<number>();
  vi.spyOn(managedCommands, "runManagedCommand").mockImplementationOnce((options) => {
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
    expect(options).toMatchObject({
      timeoutMs: 600_000,
      requireProcessTreeExit: process.platform !== "win32",
      env: { PATH: process.env.PATH },
    });
    expect(options.env).not.toHaveProperty("TSX_TSCONFIG_PATH");
    const output = fixture.file("dist/assets/message.txt");
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
    expect(fs.readFileSync(fixture.file(fixture.source), "utf8")).toBe("previous source asset");
  } finally {
    command.resolve(0);
    await built;
  }
});

it.each<AssetOptions>([
  { tracked: true },
  { dependency: "engine" },
  { dependency: "@fixture/engine", localDependency: true },
  { tracked: true, missing: true },
  { tracked: true, missing: true, dependency: "@fixture/engine", localDependency: true },
])("builds loadable assets or rejects missing sources (%j)", async (options) => {
  const fixture = createAssetFixture(options);
  if (options.missing) {
    await expect(buildPluginNpmRuntime(fixture)).rejects.toThrow(
      `demo missing static asset source(s): extensions/demo/${fixture.source}`,
    );
    return;
  }
  if (options.tracked) {
    const other = path.join(fixture.repoRoot, "extensions", "other");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "package.json"), "{");
    execFileSync("git", ["add", "extensions/other/package.json"], { cwd: fixture.repoRoot });
  }

  writeJsonFile(fixture.file("openclaw.plugin.json"), {
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
  expect(result).toMatchObject({
    packageFiles: expect.arrayContaining(["theme.json", "assets/rocket.svg"]),
    copiedStaticAssets: ["dist/assets/message.txt"],
  });
  const entry = pathToFileURL(fixture.file("dist/index.js")).href;
  const script = `process.stdout.write((await import(${JSON.stringify(entry)})).message);`;
  expect(
    execFileSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" }),
  ).toBe("selected asset");
});
