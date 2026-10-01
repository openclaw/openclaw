import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "./install-package-dir.js";

vi.mock("../process/exec.js", async () => {
  const actual = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  return { ...actual, runCommandWithTimeout: vi.fn(actual.runCommandWithTimeout) };
});

describe("package install runtime manifest", () => {
  const fixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-install-manifest-" });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixtureRootTracker.cleanup();
  });

  it.each(["install", "commit", "rollback"] as const)(
    "restores the runtime manifest before validation and %s settlement",
    async (settlement) => {
      await fixtureRootTracker.setup();
      const fixtureRoot = await fixtureRootTracker.make("case");
      const sourceDir = path.join(fixtureRoot, "source");
      const targetDir = path.join(fixtureRoot, "plugins", "demo");
      await fs.mkdir(sourceDir, { recursive: true });
      const originalManifest = Buffer.from(
        `${JSON.stringify(
          {
            name: "demo-plugin",
            version: "2.0.0",
            dependencies: {
              openclaw: ">=2026.4.5",
              yaml: "^2.0.0",
            },
            optionalDependencies: { openclaw: ">=2026.4.5", fsevents: "^2.3.3" },
            peerDependencies: {
              openclaw: ">=2026.4.5",
              zod: "^4.0.0",
            },
            peerDependenciesMeta: {
              openclaw: { optional: true },
              zod: { optional: false },
            },
            devDependencies: {
              openclaw: "2026.6.1",
              typescript: "~5.9.0",
            },
          },
          null,
          "\t",
        ).replaceAll("\n", "\r\n")}\r\n`,
      );
      await fs.writeFile(path.join(sourceDir, "package.json"), originalManifest);
      const previousManifest = '{ "name": "demo-plugin", "version": "1.0.0" }\n';
      if (settlement !== "install") {
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(path.join(targetDir, "package.json"), previousManifest);
      }

      vi.mocked(runCommandWithTimeout).mockImplementation(async (_argv, optionsOrTimeout) => {
        const cwd = typeof optionsOrTimeout === "number" ? undefined : optionsOrTimeout.cwd;
        if (cwd === undefined) {
          throw new Error("expected package install cwd");
        }
        const manifest = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
        expect(manifest).toMatchObject({
          dependencies: { yaml: "^2.0.0" },
          optionalDependencies: { fsevents: "^2.3.3" },
          peerDependencies: { zod: "^4.0.0" },
          peerDependenciesMeta: { zod: { optional: false } },
        });
        expect(manifest.dependencies).not.toHaveProperty("openclaw");
        expect(manifest.optionalDependencies).not.toHaveProperty("openclaw");
        expect(manifest.peerDependencies).not.toHaveProperty("openclaw");
        expect(manifest.peerDependenciesMeta).not.toHaveProperty("openclaw");
        expect(manifest).not.toHaveProperty("devDependencies");
        return {
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      });

      let validated = false;
      const installParams = {
        sourceDir,
        targetDir,
        mode: settlement === "install" ? ("install" as const) : ("update" as const),
        timeoutMs: 1_000,
        copyErrorPrefix: "failed to copy plugin",
        hasDeps: true,
        omitOpenClawHostDependency: true,
        depsLogMessage: "Installing deps…",
        afterInstall: async (stagedDir: string) => {
          await expect(fs.readFile(path.join(stagedDir, "package.json"))).resolves.toEqual(
            originalManifest,
          );
          validated = true;
          return { ok: true as const };
        },
      };
      const result = await installPackageDir(
        settlement === "install" ? installParams : requestDeferredPackageDirInstall(installParams),
      );
      expect(result.ok).toBe(true);
      expect(validated).toBe(true);
      await expect(fs.readFile(path.join(targetDir, "package.json"))).resolves.toEqual(
        originalManifest,
      );
      await expect(fs.readFile(path.join(sourceDir, "package.json"))).resolves.toEqual(
        originalManifest,
      );
      if (settlement !== "install") {
        const transaction = resolvePackageDirInstallTransaction(result);
        if (!transaction) {
          throw new Error("expected deferred install transaction");
        }
        await transaction[settlement]();
        await expect(fs.readFile(path.join(targetDir, "package.json"))).resolves.toEqual(
          settlement === "commit" ? originalManifest : Buffer.from(previousManifest),
        );
        await expect(
          fs.readdir(path.join(path.dirname(targetDir), ".openclaw-install-backups")),
        ).resolves.toEqual([]);
      }
      expect(runCommandWithTimeout).toHaveBeenCalledWith(
        [
          "npm",
          "install",
          "--omit=dev",
          "--loglevel=error",
          "--ignore-scripts",
          "--workspaces=false",
        ],
        expect.objectContaining({ cwd: expect.stringContaining(".openclaw-install-stage-") }),
      );
    },
  );
});
