import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as commands from "../../process/exec.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { createNodeBootstrapArtifactProvider } from "./node-bootstrap-artifact.js";

const state = vi.hoisted(() => ({ archive: "", warnings: [] as string[] }));
// mock-isolation: only archive production is replaced; the provider owns lock generation and reuse.
vi.mock("./node-bootstrap-artifact-worker.js", () => ({
  prepareNodeArtifactInWorker: async (
    _kind: string,
    { temporaryRoot }: { temporaryRoot: string },
  ) => {
    const tarballPath = path.join(temporaryRoot, "node-runtime.tgz");
    await fs.copyFile(state.archive, tarballPath);
    return {
      tarballPath,
      tarballBytes: 7,
      tarballSha256: "a".repeat(64),
      openclawVersion: "1.0.0",
      buildId: "fixture",
      enabledPluginIds: [],
    };
  },
}));
// mock-isolation: retain logger exports and capture this test's generated warnings only.
vi.mock("../../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({ warn: (message: string) => state.warnings.push(message) }),
}));
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
afterEach(() => {
  vi.restoreAllMocks();
  state.warnings.length = 0;
});

it.each([false, true])(
  "caches the archive's npm lock outcome for subsequent worker starts (failure: %s)",
  async (fail) => {
    const root = tempDirs.make("bootstrap-install-lock-");
    state.archive = path.join(root, "original.tgz");
    await fs.writeFile(state.archive, "archive");
    const lock = '{"lockfileVersion":3,"packages":{}}\n';
    // npm is the external boundary: it sees the exact archive and a fresh project, never host credentials.
    const npm = vi
      .spyOn(commands, "runCommandWithTimeout")
      .mockImplementation(async (_argv, options) => {
        if (typeof options === "number" || !options.cwd) {
          throw new Error("Missing npm project");
        }
        expect(await fs.readFile(path.join(options.cwd, "../node-runtime.tgz"), "utf8")).toBe(
          "archive",
        );
        expect(
          JSON.parse(await fs.readFile(path.join(options.cwd, "package.json"), "utf8")),
        ).toEqual({ private: true, dependencies: { openclaw: "file:../node-runtime.tgz" } });
        expect(options.baseEnv).not.toHaveProperty("GH_TOKEN");
        if (!fail) {
          await fs.writeFile(path.join(options.cwd, "package-lock.json"), lock);
        }
        return createCommandResult({
          stderr: fail ? "npm error code EALLOWREMOTE" : "",
          code: fail ? 1 : 0,
        });
      });
    const provider = createNodeBootstrapArtifactProvider({
      packageRoot: root,
      runningBuildId: "fixture",
      plugins: [],
    });
    try {
      const [first, concurrent] = await Promise.all([provider.prepare(), provider.prepare()]);
      expect(await provider.prepare()).toBe(first);
      expect(concurrent).toBe(first);
      expect(npm).toHaveBeenCalledTimes(1);
      if (fail) {
        expect(first.installLock).toBeUndefined();
        expect(state.warnings).toEqual([expect.stringContaining("EALLOWREMOTE")]);
      } else {
        expect(first.installLock).toMatchObject({
          tarballBytes: Buffer.byteLength(lock),
          tarballSha256: createHash("sha256").update(lock).digest("hex"),
        });
        expect(await fs.readFile(first.installLock!.tarballPath, "utf8")).toBe(lock);
        expect(state.warnings).toEqual([]);
      }
    } finally {
      await provider.close();
    }
  },
);
