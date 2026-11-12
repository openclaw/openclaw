import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as tempRoot from "../infra/tmp-openclaw-dir.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { prepareNodeWorkerFilesystem } from "./node-worker-filesystem.js";

const tempDirs = useStateDatabaseTempDirs();
const launcher = "/usr/local/bin/openshell-sandbox";

it.runIf(process.platform === "linux")(
  "fails closed when the OpenShell launcher is unavailable",
  async () => {
    const access = vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("missing launcher");
    });
    try {
      await expect(
        prepareNodeWorkerFilesystem({
          workspaceDir: "/workspace",
          bundleRoot: "/runtime",
          entry: "/runtime/worker.mjs",
          env: {},
          args: [],
        }),
      ).rejects.toThrow(`require ${launcher}`);
    } finally {
      access.mockRestore();
    }
  },
);

it.runIf(process.platform === "linux")(
  "rejects a workspace containing the shared node temp root",
  async () => {
    const root = tempDirs.make("worker-filesystem-overlap-");
    const home = path.join(root, "home");
    const bundle = path.join(root, "bundle");
    const workspace = path.join(root, "workspace");
    const sharedTempRoot = path.join(workspace, "shared-temp");
    fs.mkdirSync(home);
    fs.mkdirSync(bundle);
    fs.mkdirSync(sharedTempRoot, { recursive: true });
    const tempRootSpy = vi
      .spyOn(tempRoot, "resolvePreferredOpenClawTmpDir")
      .mockReturnValue(sharedTempRoot);
    const originalAccess = fs.accessSync;
    const access = vi.spyOn(fs, "accessSync").mockImplementation((target, mode) => {
      if (target !== launcher) {
        originalAccess(target, mode);
      }
    });
    try {
      await expect(
        prepareNodeWorkerFilesystem({
          workspaceDir: workspace,
          bundleRoot: bundle,
          entry: path.join(bundle, "worker.mjs"),
          homeDir: home,
          env: {},
          args: [],
        }),
      ).rejects.toThrow("Worker workspace cannot contain node runtime or private storage");
      expect(fs.existsSync(path.join(home, "model-home"))).toBe(false);
    } finally {
      access.mockRestore();
      tempRootSpy.mockRestore();
    }
  },
);

it.runIf(process.platform === "linux")(
  "prepares OpenShell grants and target-only environment",
  async () => {
    const root = tempDirs.make("worker-filesystem-contract-");
    const workspace = path.join(root, "workspace");
    const home = path.join(root, "home");
    const bundle = path.join(root, "bundle");
    for (const directory of [workspace, home, bundle]) {
      fs.mkdirSync(directory);
    }
    const originalAccess = fs.accessSync;
    const access = vi.spyOn(fs, "accessSync").mockImplementation((target, mode) => {
      if (target !== launcher) {
        originalAccess(target, mode);
      }
    });
    try {
      const result = await prepareNodeWorkerFilesystem({
        workspaceDir: workspace,
        bundleRoot: bundle,
        entry: path.join(bundle, "worker.mjs"),
        homeDir: home,
        env: { PATH: "/usr/bin" },
        args: ["worker.mjs", "--internal-worker-ipc"],
      });
      try {
        expect(result.command).toBe(launcher);
        expect(result.args[0]).toBe("restrict-exec");
        const index = result.args.indexOf("--");
        expect(result.args.slice(index)).toEqual([
          "--",
          process.execPath,
          "worker.mjs",
          "--internal-worker-ipc",
        ]);
        const optionValues = (flag: string) =>
          result.args.flatMap((value, i) => (value === flag ? [result.args[i + 1]] : []));
        expect(optionValues("--read-write")).toEqual([
          fs.realpathSync.native(workspace),
          path.join(fs.realpathSync.native(home), "model-home"),
          expect.stringMatching(/worker-/u),
          "/dev/null",
        ]);
        expect(optionValues("--cwd")).toEqual([fs.realpathSync.native(workspace)]);
        expect(optionValues("--env")).toContain(
          `HOME=${path.join(fs.realpathSync.native(home), "model-home")}`,
        );
      } finally {
        await result.cleanup();
      }
    } finally {
      access.mockRestore();
    }
  },
);
