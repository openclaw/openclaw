import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../runtime.js";
import { writeFixtureJson } from "./cli-fixtures.test-support.js";
import { registerPluginsCli } from "./plugins-cli.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function lint(root: string) {
  const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const program = new Command().exitOverride();
  registerPluginsCli(program);
  await program.parseAsync(["plugins", "lint", "--root", root, "--json"], { from: "user" });
  return writeJson;
}

const incomplete = (warning: Record<string, unknown>, fields = {}) =>
  expect.objectContaining({
    complete: false,
    ...fields,
    warnings: [expect.objectContaining({ ruleId: "scan-incomplete", ...warning })],
  });

describe("plugins lint", () => {
  it("reports an omitted source-directory link while ignoring node_modules links", async () => {
    const root = tempDirs.make("plugin-runtime-lint-link-");
    const generated = tempDirs.make("plugin-runtime-lint-generated-");
    await writeFixtureJson(path.join(root, "package.json"), { name: "directory-link" });
    await fs.writeFile(path.join(generated, "index.js"), "Buffer.concat = () => null;");
    await fs.symlink(generated, path.join(root, "runtime.assets"), "junction");
    await fs.symlink(generated, path.join(root, "node_modules"), "junction");
    expect(await lint(root)).toHaveBeenCalledExactlyOnceWith(
      incomplete({ file: "runtime.assets" }, { scannedFiles: 0 }),
    );
  });

  it.each([false, true])(
    "distinguishes absent runtime dependencies with optional=%s",
    async (optional) => {
      const root = tempDirs.make("plugin-runtime-lint-missing-");
      await writeFixtureJson(path.join(root, "package.json"), {
        name: "missing-dependencies",
        dependencies: optional ? {} : { required: "1.0.0" },
        optionalDependencies: { optional: "1.0.0" },
        peerDependencies: { "peer-required": "1.0.0", "peer-optional": "1.0.0" },
        peerDependenciesMeta: {
          "peer-required": { optional },
          "peer-optional": { optional: true },
        },
      });
      expect(await lint(root)).toHaveBeenCalledExactlyOnceWith({
        complete: optional,
        scannedFiles: 0,
        scannedPackages: 1,
        warnings: optional
          ? []
          : ["peer-required", "required"].map((name) =>
              expect.objectContaining({
                ruleId: "scan-incomplete",
                message: expect.stringContaining(`"${name}"`),
              }),
            ),
      });
    },
  );

  it("reports a malformed dependency map as incomplete", async () => {
    const root = tempDirs.make("plugin-runtime-lint-invalid-map-");
    await writeFixtureJson(path.join(root, "package.json"), {
      name: "invalid-map",
      dependencies: null,
    });
    expect(await lint(root)).toHaveBeenCalledExactlyOnceWith(
      incomplete({ message: expect.stringContaining("dependencies") }),
    );
  });

  it("reports incomplete parsing as a warning", async () => {
    const root = tempDirs.make("plugin-runtime-lint-incomplete-");
    await writeFixtureJson(path.join(root, "package.json"), { name: "parse-fixture" });
    await fs.writeFile(path.join(root, "invalid.ts"), "const broken = ;");
    const exit = vi.spyOn(defaultRuntime, "exit");
    expect(await lint(root)).toHaveBeenCalledExactlyOnceWith(incomplete({ file: "invalid.ts" }));
    expect(exit).not.toHaveBeenCalled();
  });

  it.each(["missing-root", "malformed-dependency"] as const)(
    "marks a %s manifest incomplete",
    async (scenario) => {
      const root = tempDirs.make("plugin-runtime-lint-manifest-");
      if (scenario === "malformed-dependency") {
        await writeFixtureJson(path.join(root, "package.json"), {
          name: "plugin",
          dependencies: { malformed: "1.0.0" },
        });
        const dependency = path.join(root, "node_modules", "malformed");
        await fs.mkdir(dependency, { recursive: true });
        await fs.writeFile(path.join(dependency, "package.json"), "{ broken");
      }
      expect(await lint(root)).toHaveBeenCalledExactlyOnceWith(
        incomplete({ file: "package.json" }),
      );
    },
  );
});
