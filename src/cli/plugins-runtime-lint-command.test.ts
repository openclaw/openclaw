import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../runtime.js";
import { registerPluginsCli } from "./plugins-cli.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("plugins lint", () => {
  it("reports an omitted source-directory link while ignoring node_modules links", async () => {
    const root = tempDirs.make("plugin-runtime-lint-link-");
    const generated = tempDirs.make("plugin-runtime-lint-generated-");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "directory-link" }));
    await fs.writeFile(path.join(generated, "index.js"), "Buffer.concat = () => null;");
    await fs.symlink(generated, path.join(root, "runtime.assets"), "junction");
    await fs.symlink(generated, path.join(root, "node_modules"), "junction");
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    try {
      const program = new Command().exitOverride();
      registerPluginsCli(program);
      await program.parseAsync(["plugins", "lint", "--root", root, "--json"], { from: "user" });
      expect(writeJson).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          complete: false,
          scannedFiles: 0,
          warnings: [
            expect.objectContaining({ ruleId: "scan-incomplete", file: "runtime.assets" }),
          ],
        }),
      );
    } finally {
      writeJson.mockRestore();
    }
  });

  it.each([false, true])(
    "distinguishes absent runtime dependencies with optional=%s",
    async (optional) => {
      const root = tempDirs.make("plugin-runtime-lint-missing-");
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "missing-dependencies",
          dependencies: optional ? {} : { required: "1.0.0" },
          optionalDependencies: { optional: "1.0.0" },
          peerDependencies: { "peer-required": "1.0.0", "peer-optional": "1.0.0" },
          peerDependenciesMeta: {
            "peer-required": { optional },
            "peer-optional": { optional: true },
          },
        }),
      );
      const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      try {
        const program = new Command().exitOverride();
        registerPluginsCli(program);
        await program.parseAsync(["plugins", "lint", "--root", root, "--json"], { from: "user" });
        expect(writeJson).toHaveBeenCalledExactlyOnceWith({
          complete: optional,
          scannedFiles: 0,
          scannedPackages: 1,
          warnings: optional
            ? []
            : [
                expect.objectContaining({
                  ruleId: "scan-incomplete",
                  message: expect.stringContaining('"peer-required"'),
                }),
                expect.objectContaining({
                  ruleId: "scan-incomplete",
                  message: expect.stringContaining('"required"'),
                }),
              ],
        });
      } finally {
        writeJson.mockRestore();
      }
    },
  );

  it.each([null, "invalid"])(
    "reports a malformed dependency map %s as incomplete",
    async (dependencies) => {
      const root = tempDirs.make("plugin-runtime-lint-invalid-map-");
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "invalid-map", dependencies }),
      );
      const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      try {
        const program = new Command().exitOverride();
        registerPluginsCli(program);
        await program.parseAsync(["plugins", "lint", "--root", root, "--json"], { from: "user" });
        expect(writeJson).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            complete: false,
            warnings: [
              expect.objectContaining({
                ruleId: "scan-incomplete",
                message: expect.stringContaining("dependencies"),
              }),
            ],
          }),
        );
      } finally {
        writeJson.mockRestore();
      }
    },
  );

  it("reports incomplete parsing as a warning", async () => {
    const root = tempDirs.make("plugin-runtime-lint-incomplete-");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "parse-fixture" }));
    await fs.writeFile(path.join(root, "invalid.ts"), "const broken = ;");
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit");
    try {
      const program = new Command().exitOverride();
      registerPluginsCli(program);
      await program.parseAsync(["plugins", "lint", "--root", root, "--json"], { from: "user" });
      expect(writeJson).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          complete: false,
          warnings: [expect.objectContaining({ ruleId: "scan-incomplete", file: "invalid.ts" })],
        }),
      );
      expect(exit).not.toHaveBeenCalled();
    } finally {
      writeJson.mockRestore();
      exit.mockRestore();
    }
  });

  it.each(["missing-root", "malformed-dependency"] as const)(
    "marks a %s manifest incomplete",
    async (scenario) => {
      const root = tempDirs.make("plugin-runtime-lint-manifest-");
      if (scenario === "malformed-dependency") {
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: "plugin", dependencies: { malformed: "1.0.0" } }),
        );
        const dependency = path.join(root, "node_modules", "malformed");
        await fs.mkdir(dependency, { recursive: true });
        await fs.writeFile(path.join(dependency, "package.json"), "{ broken");
      }
      const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      try {
        const program = new Command().exitOverride();
        registerPluginsCli(program);
        await program.parseAsync(["plugins", "lint", "--root", root, "--json"], { from: "user" });
        expect(writeJson).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            complete: false,
            warnings: [
              expect.objectContaining({ ruleId: "scan-incomplete", file: "package.json" }),
            ],
          }),
        );
      } finally {
        writeJson.mockRestore();
      }
    },
  );
});
