import { link, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
  runtimeNeedsTypeScriptLoader,
} from "./runtime-worker-url.js";

describe("resolveRuntimeWorkerUrl", () => {
  it("selects plugin package paths with hardlinked manifests, renamed directories, and chunks", async () => {
    await withTempDir("openclaw-renamed-worker-package-", async (root) => {
      const entry = {
        sourceWorkerName: "store.worker",
        distWorkerPath: "extensions/store/store.worker.js",
        package: { name: "@openclaw/store", distWorkerPath: "src/store.worker.js" },
      };
      await writeFile(path.join(root, "package-store.json"), "{}");
      await link(path.join(root, "package-store.json"), path.join(root, "package.json"));
      for (const packageName of ["openclaw", "@openclaw/store"]) {
        await writeFile(path.join(root, "package.json"), JSON.stringify({ name: packageName }));
        for (const modulePath of ["dist/index.js", "dist/.setup/shared-abc.mjs"]) {
          const currentModuleUrl = pathToFileURL(path.join(root, modulePath)).href;
          expect(fileURLToPath(resolveRuntimeWorkerUrl({ ...entry, currentModuleUrl }))).toBe(
            path.join(
              root,
              "dist",
              packageName === entry.package.name
                ? entry.package.distWorkerPath
                : entry.distWorkerPath,
            ),
          );
          expect(fileURLToPath(resolveRuntimeWorkerUrl({ ...entry, currentModuleUrl, root }))).toBe(
            path.join(root, "dist", entry.distWorkerPath),
          );
        }
      }
      await writeFile(path.join(root, "package.json"), "invalid-json");
      expect(() =>
        resolveRuntimeWorkerUrl({
          ...entry,
          currentModuleUrl: pathToFileURL(path.join(root, "dist/index.js")).href,
        }),
      ).toThrow("Cannot resolve runtime worker package");
      expect(
        fileURLToPath(
          resolveRuntimeWorkerUrl({
            ...entry,
            currentModuleUrl: pathToFileURL(path.join(root, "src/entry.ts")).href,
          }),
        ),
      ).toBe(path.join(root, "src/store.worker.ts"));
    });
  });
});

describe("resolveRuntimeWorkerArgv", () => {
  it.each([{ runtime: "Node", bun: undefined, executable: "bun" }])(
    "uses current $runtime metadata without changing foreign runtimes",
    ({ bun, executable }) => {
      const descriptors = Object.getOwnPropertyDescriptors(process);
      const currentExecutable = path.resolve("current-runtime-fixture", executable);
      try {
        Object.defineProperties(process, {
          execPath: { configurable: true, value: currentExecutable },
          versions: { configurable: true, value: { ...process.versions, bun } },
        });
        for (const extension of ["ts", "mts", "cts", "js", "mjs"]) {
          const url = pathToFileURL(path.resolve(`worker fixture.${extension}`));
          for (const { selected, typescriptLoader } of [
            { selected: undefined, typescriptLoader: !bun },
            { selected: currentExecutable, typescriptLoader: !bun },
            { selected: path.resolve("foreign-runtime-fixture", "node"), typescriptLoader: true },
            { selected: path.resolve("foreign-runtime-fixture", "bun"), typescriptLoader: false },
          ]) {
            const needsLoader = typescriptLoader && extension.endsWith("ts");
            expect(resolveRuntimeWorkerArgv(url, selected)).toEqual([
              ...(typescriptLoader ? [] : ["--no-install"]),
              ...(needsLoader ? ["--import", import.meta.resolve("tsx")] : []),
              fileURLToPath(url),
            ]);
            expect(resolveRuntimeWorkerThreadExecArgv(url, selected)).toEqual(
              needsLoader ? ["--import", import.meta.resolve("tsx/esm")] : [],
            );
            expect(runtimeNeedsTypeScriptLoader(fileURLToPath(url), selected)).toBe(needsLoader);
          }
        }
      } finally {
        Object.defineProperties(process, {
          execPath: descriptors.execPath,
          versions: descriptors.versions,
        });
      }
    },
  );
});

describe("resolveRuntimeProcessEntrypointUrl", () => {
  it("uses canonical launchers unless the sealed bundle registers a sibling", async () => {
    vi.resetModules();
    try {
      const { registerSealedRuntimeProcessEntrypoint, resolveRuntimeProcessEntrypointUrl } =
        await import("./runtime-process-url.js");
      const { runtimeProcessEntrypoints } = await import("./runtime-process-entrypoints.js");
      expect(resolveRuntimeProcessEntrypointUrl("githubExec")).toEqual(
        resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.githubExec),
      );
      const sqliteUrl = resolveRuntimeProcessEntrypointUrl("sqliteReadOnly");
      const sealedUrl = new URL("file:///worker-bundle/github-exec-launcher.mjs");
      registerSealedRuntimeProcessEntrypoint("githubExec", sealedUrl);
      expect(resolveRuntimeProcessEntrypointUrl("githubExec")).toEqual(sealedUrl);
      expect(resolveRuntimeProcessEntrypointUrl("sqliteReadOnly")).toEqual(sqliteUrl);
    } finally {
      vi.resetModules();
    }
  });
});
