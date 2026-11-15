import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { runBuildAllSteps } from "../../scripts/build-all.mts";
import * as liveGatewayDistFence from "../../scripts/lib/live-gateway-dist-fence.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const lockFile = ".artifacts/dist-artifacts.lock/owner.json";
const stager = "scripts/stage-bundled-plugin-runtime.mts";
const ownerRecord = (pid = process.pid) =>
  JSON.stringify({ pid, startedAt: "2026-09-24T12:00:00.000Z" });

function installedCheckout() {
  // Keep host service discovery outside this installed-artifact ownership fixture.
  const fence = vi
    .spyOn(liveGatewayDistFence, "resolveLiveManagedGatewayDistFence")
    .mockResolvedValue({ refuse: false });
  onTestFinished(() => fence.mockRestore());
  const root = tempDirs.make("openclaw-installed-artifact-preflight-");
  const { write } = fixtureFiles(root);
  fs.mkdirSync(path.join(root, ".git"));
  write("package.json", '{"name":"openclaw","type":"module"}');
  write("tsconfig.json", '{"compilerOptions":{"target":"ESNext","module":"ESNext"}}');
  fs.symlinkSync(path.join(process.cwd(), "scripts"), path.join(root, "scripts"), "junction");
  write("dist/extensions/demo/index.js", "export const current = true;\n");
  const serving = write("dist-runtime/extensions/demo/index.js", "previous serving generation\n");
  const ownerPath = path.join(root, lockFile);
  const env = {
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    BUILD_ALL_CACHE_ROOT: path.join(root, ".artifacts/build-all-cache"),
  };
  const runStep = vi.fn(() => ({ status: 0 }));
  const run = (prepared?: boolean) =>
    runBuildAllSteps("gatewayWatch", {
      env: prepared === undefined ? env : { ...env, sourceRuntimePrepared: String(prepared) },
      steps: [{ label: "candidate build", args: ["candidate-build.mjs"] }],
      runStep,
      logger: { error: vi.fn(), warn: vi.fn() },
      now: () => 0,
      resolveCacheState: () => ({ cacheable: false, fresh: false, reason: "no-cache" }),
    });
  const before = fs.statSync(serving);
  const expectPreserved = () => {
    expect(fs.readFileSync(serving, "utf8")).toBe("previous serving generation\n");
    expect(fs.statSync(serving)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });
  };
  const replaceScripts = (source?: string) => {
    fs.unlinkSync(path.join(root, "scripts"));
    if (source !== undefined) {
      write(stager, source);
    }
  };
  const owner = () => (fs.existsSync(ownerPath) ? fs.readFileSync(ownerPath, "utf8") : undefined);
  return { root, write, owner, env, runStep, run, expectPreserved, replaceScripts };
}

describe("published source updater candidate-build preflight", () => {
  it.each(["dead owner", "live owner", "symlink", "invalid writer"])(
    "refuses %s before candidate work and preserves serving artifacts",
    async (hazard) => {
      const f = installedCheckout();
      const pid = hazard === "dead owner" ? 2147483647 : process.pid;
      const owner = ownerRecord(pid);
      let error: string;
      if (hazard.endsWith("owner")) {
        f.write(lockFile, owner);
        error = `retained by PID ${pid}`;
      } else if (hazard === "symlink") {
        const liveRoot = path.join(f.root, "serving-runtime");
        fs.renameSync(path.join(f.root, "dist-runtime"), liveRoot);
        fs.symlinkSync(liveRoot, path.join(f.root, "dist-runtime"), "junction");
        error = "is a symbolic link";
      } else {
        f.replaceScripts(
          "export const prepareBundledPluginRuntime = false; export function stageBundledPluginRuntime() {}\n",
        );
        error = "Installed runtime staging is unavailable";
      }
      await expect(f.run()).rejects.toThrow(error);
      expect(f.runStep).not.toHaveBeenCalled();
      expect(f.owner()).toBe(hazard.endsWith("owner") ? owner : undefined);
      if (hazard.endsWith("owner")) {
        expect(liveGatewayDistFence.resolveLiveManagedGatewayDistFence).not.toHaveBeenCalled();
        expect(fs.existsSync(f.env.BUILD_ALL_CACHE_ROOT)).toBe(false);
      }
      f.expectPreserved();
    },
  );
  it.each(["current", "2026.4.27", "2026.9.4", true, false])(
    "preserves installed completion and consumes driver preparation: %s",
    async (variant) => {
      const prepared = typeof variant === "boolean" ? variant : undefined;
      const version = typeof variant === "string" ? variant : "current";
      const f = installedCheckout();
      if (version !== "current") {
        f.replaceScripts(
          version === "2026.9.4"
            ? "export function stageBundledPluginRuntime() { throw Error('legacy stager called'); }\n"
            : undefined,
        );
      }
      const record = ownerRecord();
      if (prepared !== undefined) {
        f.write(lockFile, record);
      }
      expect((await f.run(prepared)).exitCode).toBe(0);
      expect(f.runStep).toHaveBeenCalledOnce();
      expect(f.owner()).toBe(prepared === undefined ? undefined : record);
      f.expectPreserved();
      expect(
        fs.readdirSync(f.root).filter((name) => name.startsWith(".openclaw-runtime-")),
      ).toEqual([]);
    },
  );
});
