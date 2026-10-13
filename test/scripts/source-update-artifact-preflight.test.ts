import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { runBuildAllSteps } from "../../scripts/build-all.mts";
import * as liveGatewayDistFence from "../../scripts/lib/live-gateway-dist-fence.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  // Keep host service discovery outside this installed-artifact ownership fixture.
  const fence = vi
    .spyOn(liveGatewayDistFence, "resolveLiveManagedGatewayDistFence")
    .mockResolvedValue({ refuse: false });
  onTestFinished(() => fence.mockRestore());
});

function installedCheckout() {
  const root = tempDirs.make("openclaw-installed-artifact-preflight-");
  const write = (relative: string, content: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  fs.mkdirSync(path.join(root, ".git"));
  write("package.json", '{"name":"openclaw","type":"module"}');
  write("tsconfig.json", '{"compilerOptions":{"target":"ESNext","module":"ESNext"}}');
  fs.symlinkSync(path.join(process.cwd(), "scripts"), path.join(root, "scripts"), "junction");
  write("dist/extensions/demo/index.js", "export const current = true;\n");
  const serving = write("dist-runtime/extensions/demo/index.js", "previous serving generation\n");
  const ownerPath = path.join(root, ".artifacts/dist-artifacts.lock/owner.json");
  const env = {
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    BUILD_ALL_CACHE_ROOT: path.join(root, ".artifacts/build-all-cache"),
  };
  const runStep = vi.fn(() => ({ status: 0 }));
  const run = (buildEnv: NodeJS.ProcessEnv = env) =>
    runBuildAllSteps("gatewayWatch", {
      env: buildEnv,
      steps: [{ label: "candidate build", args: ["candidate-build.mjs"] }],
      runStep,
      logger: { error: vi.fn(), warn: vi.fn() },
      now: () => 0,
      resolveCacheState: () => ({ cacheable: false, fresh: false, reason: "no-cache" }),
    });
  return { root, write, serving, ownerPath, env, runStep, run };
}

describe("published source updater candidate-build preflight", () => {
  it.each(["dead owner", "live owner", "symlink", "invalid writer"])(
    "refuses %s before candidate work and preserves serving artifacts",
    async (hazard) => {
      const fixture = installedCheckout();
      const before = fs.statSync(fixture.serving);
      const pid = hazard === "dead owner" ? 2147483647 : process.pid;
      const owner = JSON.stringify({ pid, startedAt: "2026-09-24T12:00:00.000Z" });
      let error: string;
      if (hazard.endsWith("owner")) {
        fixture.write(".artifacts/dist-artifacts.lock/owner.json", owner);
        error = `retained by PID ${pid}`;
      } else if (hazard === "symlink") {
        const liveRoot = path.join(fixture.root, "serving-runtime");
        fs.renameSync(path.join(fixture.root, "dist-runtime"), liveRoot);
        fs.symlinkSync(liveRoot, path.join(fixture.root, "dist-runtime"), "junction");
        error = "is a symbolic link";
      } else {
        fs.unlinkSync(path.join(fixture.root, "scripts"));
        fixture.write(
          "scripts/stage-bundled-plugin-runtime.mts",
          "export const prepareBundledPluginRuntime = false; export function stageBundledPluginRuntime() {}\n",
        );
        error = "Installed runtime staging is unavailable";
      }
      await expect(fixture.run()).rejects.toThrow(error);
      expect(fixture.runStep).not.toHaveBeenCalled();
      if (hazard.endsWith("owner")) {
        expect(liveGatewayDistFence.resolveLiveManagedGatewayDistFence).not.toHaveBeenCalled();
        expect(fs.readFileSync(fixture.ownerPath, "utf8")).toBe(owner);
        expect(fs.existsSync(fixture.env.BUILD_ALL_CACHE_ROOT)).toBe(false);
      } else {
        expect(fs.existsSync(fixture.ownerPath)).toBe(false);
      }
      expect(fs.readFileSync(fixture.serving, "utf8")).toBe("previous serving generation\n");
      expect(fs.statSync(fixture.serving)).toMatchObject({
        ino: before.ino,
        mtimeMs: before.mtimeMs,
      });
    },
  );

  it.each([
    { version: "current" },
    { version: "2026.4.27" },
    { version: "2026.9.4" },
    { version: "current", prepared: true },
    { version: "current", prepared: false },
  ])(
    "preserves installed completion and consumes driver preparation: %j",
    async ({ version, prepared }) => {
      const fixture = installedCheckout();
      const before = fs.statSync(fixture.serving);
      if (version !== "current") {
        fs.unlinkSync(path.join(fixture.root, "scripts"));
        if (version === "2026.9.4") {
          fixture.write(
            "scripts/stage-bundled-plugin-runtime.mts",
            "export function stageBundledPluginRuntime() { throw new Error('destructive legacy stager called'); }\n",
          );
        }
      }
      const record = JSON.stringify({ pid: process.pid, startedAt: "2026-09-24T12:00:00.000Z" });
      if (prepared !== undefined) {
        fixture.write(".artifacts/dist-artifacts.lock/owner.json", record);
      }
      const env =
        prepared === undefined
          ? fixture.env
          : { ...fixture.env, sourceRuntimePrepared: String(prepared) };
      expect((await fixture.run(env)).exitCode).toBe(0);
      expect(fixture.runStep).toHaveBeenCalledOnce();
      if (prepared === undefined) {
        expect(fs.existsSync(fixture.ownerPath)).toBe(false);
      } else {
        expect(fs.readFileSync(fixture.ownerPath, "utf8")).toBe(record);
      }
      expect(fs.readFileSync(fixture.serving, "utf8")).toBe("previous serving generation\n");
      expect(fs.statSync(fixture.serving)).toMatchObject({
        ino: before.ino,
        mtimeMs: before.mtimeMs,
      });
      expect(
        fs.readdirSync(fixture.root).filter((name) => name.startsWith(".openclaw-runtime-")),
      ).toEqual([]);
    },
  );
});
