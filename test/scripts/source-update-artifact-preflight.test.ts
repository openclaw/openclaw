import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBuildAllSteps } from "../../scripts/build-all.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
  it.each([
    { name: "dead", pid: 2147483647 },
    { name: "live", pid: process.pid },
  ])(
    "refuses a $name installed owner before candidate work without reclaiming it",
    async ({ pid }) => {
      const fixture = installedCheckout();
      const owner = JSON.stringify({ pid, startedAt: "2026-09-24T12:00:00.000Z" });
      fixture.write(".artifacts/dist-artifacts.lock/owner.json", owner);
      const before = fs.statSync(fixture.serving);

      await expect(fixture.run()).rejects.toThrow(`retained by PID ${pid}`);

      expect(fixture.runStep).not.toHaveBeenCalled();
      expect(fs.readFileSync(fixture.ownerPath, "utf8")).toBe(owner);
      expect(fs.readFileSync(fixture.serving, "utf8")).toBe("previous serving generation\n");
      expect(fs.statSync(fixture.serving)).toMatchObject({
        ino: before.ino,
        mtimeMs: before.mtimeMs,
      });
      expect(fs.existsSync(fixture.env.BUILD_ALL_CACHE_ROOT)).toBe(false);
    },
  );

  it("probes available installed completion and releases without publishing its staged output", async () => {
    const fixture = installedCheckout();
    const before = fs.statSync(fixture.serving);

    expect((await fixture.run()).exitCode).toBe(0);

    expect(fixture.runStep).toHaveBeenCalledOnce();
    expect(fs.existsSync(fixture.ownerPath)).toBe(false);
    expect(fs.readFileSync(fixture.serving, "utf8")).toBe("previous serving generation\n");
    expect(fs.statSync(fixture.serving)).toMatchObject({
      ino: before.ino,
      mtimeMs: before.mtimeMs,
    });
    expect(
      fs.readdirSync(fixture.root).filter((name) => name.startsWith(".openclaw-runtime-")),
    ).toEqual([]);
  });

  it.each([true, false])(
    "consumes the modern driver's prepared fact (%s) without another admission",
    async (prepared) => {
      const fixture = installedCheckout();
      const record = JSON.stringify({ pid: process.pid, startedAt: "2026-09-24T12:00:00.000Z" });
      fixture.write(".artifacts/dist-artifacts.lock/owner.json", record);
      expect(
        (await fixture.run({ ...fixture.env, sourceRuntimePrepared: String(prepared) })).exitCode,
      ).toBe(0);
      expect(fixture.runStep).toHaveBeenCalledOnce();
      expect(fs.readFileSync(fixture.ownerPath, "utf8")).toBe(record);
    },
  );

  it("rejects installed completion output-root hazards before candidate work", async () => {
    const fixture = installedCheckout();
    const liveRoot = path.join(fixture.root, "serving-runtime");
    fs.renameSync(path.join(fixture.root, "dist-runtime"), liveRoot);
    fs.symlinkSync(liveRoot, path.join(fixture.root, "dist-runtime"), "junction");

    await expect(fixture.run()).rejects.toThrow("is a symbolic link");

    expect(fixture.runStep).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.ownerPath)).toBe(false);
    expect(fs.readFileSync(fixture.serving, "utf8")).toBe("previous serving generation\n");
  });

  it("refuses an invalid prepared writer instead of treating it as a legacy stager", async () => {
    const fixture = installedCheckout();
    fs.unlinkSync(path.join(fixture.root, "scripts"));
    fixture.write(
      "scripts/stage-bundled-plugin-runtime.mts",
      "export const prepareBundledPluginRuntime = false; export function stageBundledPluginRuntime() {}\n",
    );
    await expect(fixture.run()).rejects.toThrow("Installed runtime staging is unavailable");
    expect(fixture.runStep).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.ownerPath)).toBe(false);
  });

  it.each(["2026.4.27", "2026.9.4"])(
    "preserves the %s source completion contract",
    async (version) => {
      const fixture = installedCheckout();
      fs.unlinkSync(path.join(fixture.root, "scripts"));
      if (version === "2026.9.4") {
        fixture.write(
          "scripts/stage-bundled-plugin-runtime.mts",
          "export function stageBundledPluginRuntime() { throw new Error('destructive legacy stager called'); }\n",
        );
      }

      expect((await fixture.run()).exitCode).toBe(0);

      expect(fixture.runStep).toHaveBeenCalledOnce();
      expect(fs.existsSync(fixture.ownerPath)).toBe(false);
      expect(fs.readFileSync(fixture.serving, "utf8")).toBe("previous serving generation\n");
    },
  );
});
