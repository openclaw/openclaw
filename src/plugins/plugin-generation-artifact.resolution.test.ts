import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import * as jitiFactory from "./jiti-factory.js";
import { createPluginCaptureResolver } from "./plugin-capture-resolution.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { captureResources, writeTree } from "./plugin-generation-capture.test-support.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "bounds resolution work for fifty TypeScript imports (custody: %s)",
  async (custody) => {
    const root = temp.make("plugin-resolution-");
    const entry = path.join(root, "index.ts");
    const imports: string[] = [];
    for (let index = 0; index < 25; index++) {
      const directory = path.join(root, `part-${index}`);
      writeTree(directory, {
        "value.ts": `export const value = ${index};`,
        "index.ts": 'export { value } from "./value.js";',
      });
      imports.push(`export { value as value${index} } from "./part-${index}/index.js";`);
    }
    fs.writeFileSync(entry, imports.join("\n"));
    const createResolver = vi.spyOn(jitiFactory, "createJiti");
    const captureStack = Error.captureStackTrace.bind(Error);
    let resolutionErrors = 0;
    vi.spyOn(Error, "captureStackTrace").mockImplementation((target, constructor) => {
      resolutionErrors += Error.stackTraceLimit === Infinity ? 1 : 0;
      captureStack(target, constructor);
    });
    const capture = async () => {
      await using resources = captureResources();
      const artifact = resources.keep(capturePluginGenerationArtifact(root, entry, (run) => run()));
      for (let index = 0; index < 25; index++) {
        expect(
          fs.readFileSync(artifact.resolve(path.join(root, `part-${index}/value.ts`)), "utf8"),
        ).toBe(`export const value = ${index};`);
      }
      expect.soft(createResolver.mock.calls.length).toBeLessThanOrEqual(custody ? 3 : 1);
      expect(resolutionErrors).toBe(0);
    };
    await (custody ? withPluginGenerationSourceCustody(capture) : capture());
  },
);

it.each(["value.js", "value.js.ts", "value.js/index.js", "value.js.json", "value.js.mjs.js"])(
  "matches Jiti's TypeScript sibling selection alongside %s",
  async (selected) => {
    await using resources = captureResources();
    const root = temp.make("plugin-resolution-precedence-");
    const entry = path.join(root, "index.ts");
    const winner = path.join(root, selected);
    writeTree(root, {
      [selected]: selected.endsWith(".json") ? "{}" : "export const value = 1;",
      "value.ts": "export const value = 2;",
      "index.ts": 'import "./value.js";',
    });
    // Native loader hooks can select a TS sibling before Jiti's final require fallback.
    const expected = fileURLToPath(
      jitiFactory
        .createJiti(entry, { fsCache: false, moduleCache: false, tryNative: false })
        .esmResolve(path.join(root, "value.js"), { conditions: ["node", "module-sync", "import"] }),
    );
    const artifact = resources.keep(capturePluginGenerationArtifact(root, entry));
    expect(artifact.hasSource(expected)).toBe(true);
    const rejected = expected === winner ? path.join(root, "value.ts") : winner;
    expect(artifact.hasSource(rejected)).toBe(false);
  },
);

it("resolves package alias targets from the importing source", () => {
  const root = temp.make("plugin-resolution-alias-");
  const nested = path.join(root, "nested");
  for (const directory of [root, nested]) {
    writeTree(directory, {
      "index.ts": "",
      "node_modules/fixture/package.json": { main: "index.js" },
      "node_modules/fixture/index.js": "exports.value = 1;",
    });
  }
  const reference = path.join(root, "alias.js");
  const resolution = createPluginCaptureResolver({ alias: { [reference]: "fixture" } });
  resolution.get(path.join(root, "index.ts"));
  expect(resolution.resolve(path.join(nested, "index.ts"), reference, ["node", "require"])).toBe(
    pathToFileURL(path.join(nested, "node_modules/fixture/index.js")).href,
  );
});

it("leaves a looping TypeScript sibling unresolved during capture", async () => {
  await using resources = captureResources();
  const root = temp.make("plugin-resolution-loop-");
  const entry = path.join(root, "index.ts");
  fs.writeFileSync(entry, 'import "./value.js";');
  fs.symlinkSync("value.ts", path.join(root, "value.ts"), "file");
  const artifact = resources.keep(capturePluginGenerationArtifact(root, entry));
  expect(artifact.hasSource(entry)).toBe(true);
  expect(artifact.hasSource(path.join(root, "value.ts"))).toBe(false);
});

function fixture(resources: ReturnType<typeof captureResources>) {
  const root = temp.make("capture-dependency-links-");
  writeTree(root, {
    "package.json": { name: "fixture", dependencies: { dependency: "*", sibling: "*" } },
    "index.cjs": "exports.ready = true;",
    "node_modules/dependency/package.json": { name: "dependency", main: "index.cjs" },
    "node_modules/dependency/index.cjs": "module.exports = 'captured dependency';",
    "node_modules/sibling/package.json": { name: "sibling", main: "index.cjs" },
    "node_modules/sibling/index.cjs": "module.exports = 'unaffected sibling';",
  });
  const artifact = resources.keep(
    capturePluginGenerationArtifact(root, path.join(root, "index.cjs"), (run) => run()),
  );
  const entry = artifact.resolve(path.join(root, "index.cjs"));
  const link = path.join(artifact.rootDir, "node_modules", "dependency");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  return { artifact, entry, link, root };
}

it.each(["relative symlink", "absolute junction"])(
  "repairs a dangling %s before loading captured dependencies",
  async (layout) => {
    await using resources = captureResources();
    const { artifact, entry, link, root } = fixture(resources);
    const disposed = path.join(root, "disposed-capture");
    fs.symlinkSync(
      layout === "absolute junction" ? disposed : path.relative(path.dirname(link), disposed),
      link,
      layout === "absolute junction" ? "junction" : "dir",
    );
    expect(fs.existsSync(link)).toBe(false);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const rename = fs.renameSync;
    let publishedAtomically = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === link) {
        // Replacement is ready while the original entry still exists, including a junction.
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(path.join(String(from), "index.cjs"), "utf8")).toContain(
          "captured dependency",
        );
        publishedAtomically = true;
      }
      rename(from, to);
    });

    const additions = artifact.prepareDependency(entry, "dependency");
    expect(additions).toContain(link);
    expect(publishedAtomically).toBe(process.platform !== "win32");
    expect(createRequire(entry)("dependency")).toBe("captured dependency");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Replacing"));
    artifact.prepareNativeScopes(entry);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(createRequire(entry)("sibling")).toBe("unaffected sibling");
  },
);

it("replaces a live link to another target without changing that target", async () => {
  await using resources = captureResources();
  const { artifact, entry, link, root } = fixture(resources);
  const previous = path.join(root, "previous");
  writeTree(previous, {
    "package.json": { main: "index.cjs" },
    "index.cjs": "module.exports = 'previous dependency';",
  });
  fs.symlinkSync(previous, link, "junction");
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

  artifact.prepareDependency(entry, "dependency");
  expect(createRequire(entry)("dependency")).toBe("captured dependency");
  expect(fs.readFileSync(path.join(previous, "index.cjs"), "utf8")).toContain(
    "previous dependency",
  );
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("Replacing"));
});

it("preserves a real dependency directory", async () => {
  await using resources = captureResources();
  const { artifact, entry, link } = fixture(resources);
  writeTree(link, {
    "package.json": { main: "index.cjs" },
    "index.cjs": "module.exports = 'nested install';",
  });
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

  artifact.prepareDependency(entry, "dependency");
  expect(fs.lstatSync(link).isDirectory()).toBe(true);
  expect(createRequire(entry)("dependency")).toBe("nested install");
  expect(warning).not.toHaveBeenCalled();
});

it.each(["EPERM", "EISDIR"])(
  "repairs Windows junctions when rename cannot replace directories (%s)",
  async (code) => {
    await using resources = captureResources();
    const { artifact, entry, link, root } = fixture(resources);
    artifact.prepareDependency(entry, "dependency");
    artifact.prepareDependency(entry, "sibling");
    const target = fs.realpathSync(link);
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(root, "disposed-capture"), link, "junction");
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === link && fs.lstatSync(link, { throwIfNoEntry: false })) {
        throw Object.assign(new Error("cannot replace a directory junction"), { code });
      }
      rename(from, to);
    });
    const symlink = fs.symlinkSync;
    let recreated = false;
    vi.spyOn(fs, "symlinkSync").mockImplementation((destination, filename, type) => {
      if (filename === link) {
        expect(fs.lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
        recreated = true;
      }
      symlink(destination, filename, type);
    });
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    withMockedPlatform("win32", () => artifact.prepareNativeScopes(entry));
    expect(recreated).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(target);
    expect(createRequire(entry)("dependency")).toBe("captured dependency");
  },
);

it("marks a capture unprepared after dependency link creation fails", async () => {
  await using resources = captureResources();
  const { artifact, entry, link, root } = fixture(resources);
  fs.symlinkSync(path.join(root, "disposed-capture"), link, "junction");
  const symlink = fs.symlinkSync;
  const failure = vi.spyOn(fs, "symlinkSync").mockImplementation((destination, filename, type) => {
    if (String(filename).startsWith(link)) {
      throw Object.assign(new Error("dependency link permission denied"), { code: "EACCES" });
    }
    symlink(destination, filename, type);
  });

  expect(() => artifact.prepareDependency(entry, "dependency")).toThrowError(
    /Cannot prepare dependency dependency for plugin/,
  );
  expect(() => artifact.assertModuleAvailable(link)).toThrowError(
    /Cannot prepare dependency dependency for plugin/,
  );
  failure.mockRestore();
  expect(() => artifact.prepareDependency(entry, "dependency")).toThrowError(
    /Cannot prepare dependency dependency for plugin/,
  );
  expect(fs.readdirSync(path.dirname(link))).toEqual(["dependency"]);
});
