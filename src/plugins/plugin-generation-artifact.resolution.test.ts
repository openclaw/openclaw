import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as jitiFactory from "./jiti-factory.js";
import { createPluginCaptureResolver } from "./plugin-capture-resolution.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "bounds resolution work for fifty TypeScript imports (custody: %s)",
  async (custody) => {
    const root = temp.make("plugin-resolution-");
    const entry = path.join(root, "index.ts");
    const imports: string[] = [];
    for (let index = 0; index < 25; index++) {
      const directory = path.join(root, `part-${index}`);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "value.ts"), `export const value = ${index};`);
      fs.writeFileSync(path.join(directory, "index.ts"), 'export { value } from "./value.js";');
      imports.push(`export { value as value${index} } from "./part-${index}/index.js";`);
    }
    fs.writeFileSync(entry, imports.join("\n"));
    const createResolver = vi.spyOn(jitiFactory, "createJiti");
    const captureStack = Error.captureStackTrace.bind(Error);
    let resolutionErrors = 0;
    vi.spyOn(Error, "captureStackTrace").mockImplementation((target, constructor) => {
      if (Error.stackTraceLimit === Infinity) {
        resolutionErrors++;
      }
      captureStack(target, constructor);
    });
    const capture = async () => {
      const artifact = capturePluginGenerationArtifact(root, entry, (run) => run());
      try {
        for (let index = 0; index < 25; index++) {
          expect(
            fs.readFileSync(artifact.resolve(path.join(root, `part-${index}/value.ts`)), "utf8"),
          ).toBe(`export const value = ${index};`);
        }
        expect.soft(createResolver.mock.calls.length).toBeLessThanOrEqual(custody ? 3 : 1);
        expect(resolutionErrors).toBe(0);
      } finally {
        await artifact.disposeAsync();
      }
    };
    if (custody) {
      await withPluginGenerationSourceCustody(capture);
    } else {
      await capture();
    }
  },
);

it.each(["value.js", "value.js.ts", "value.js/index.js", "value.js.json", "value.js.mjs.js"])(
  "matches Jiti's TypeScript sibling selection alongside %s",
  (selected) => {
    const root = temp.make("plugin-resolution-precedence-");
    const entry = path.join(root, "index.ts");
    const winner = path.join(root, selected);
    fs.mkdirSync(path.dirname(winner), { recursive: true });
    fs.writeFileSync(winner, selected.endsWith(".json") ? "{}" : "export const value = 1;");
    fs.writeFileSync(path.join(root, "value.ts"), "export const value = 2;");
    fs.writeFileSync(entry, 'import "./value.js";');
    // Native loader hooks can select a TS sibling before Jiti's final require fallback.
    const expected = fileURLToPath(
      jitiFactory
        .createJiti(entry, {
          fsCache: false,
          moduleCache: false,
          tryNative: false,
        })
        .esmResolve(path.join(root, "value.js"), { conditions: ["node", "module-sync", "import"] }),
    );
    const artifact = capturePluginGenerationArtifact(root, entry);
    try {
      expect(artifact.hasSource(expected)).toBe(true);
      expect(artifact.hasSource(expected === winner ? path.join(root, "value.ts") : winner)).toBe(
        false,
      );
    } finally {
      artifact.dispose();
    }
  },
);

it("resolves package alias targets from the importing source", () => {
  const root = temp.make("plugin-resolution-alias-");
  const nested = path.join(root, "nested");
  for (const directory of [root, nested]) {
    const dependency = path.join(directory, "node_modules", "fixture");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(path.join(directory, "index.ts"), "");
    fs.writeFileSync(path.join(dependency, "package.json"), '{"main":"index.js"}');
    fs.writeFileSync(path.join(dependency, "index.js"), "exports.value = 1;");
  }
  const reference = path.join(root, "alias.js");
  const resolution = createPluginCaptureResolver({ alias: { [reference]: "fixture" } });
  resolution.get(path.join(root, "index.ts"));
  expect(resolution.resolve(path.join(nested, "index.ts"), reference, ["node", "require"])).toBe(
    pathToFileURL(path.join(nested, "node_modules/fixture/index.js")).href,
  );
});

it("leaves a looping TypeScript sibling unresolved during capture", () => {
  const root = temp.make("plugin-resolution-loop-");
  const entry = path.join(root, "index.ts");
  fs.writeFileSync(entry, 'import "./value.js";');
  fs.symlinkSync("value.ts", path.join(root, "value.ts"), "file");
  const artifact = capturePluginGenerationArtifact(root, entry);
  try {
    expect(artifact.hasSource(entry)).toBe(true);
    expect(artifact.hasSource(path.join(root, "value.ts"))).toBe(false);
  } finally {
    artifact.dispose();
  }
});
