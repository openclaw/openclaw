import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pin from "../../scripts/lib/openclaw-bun.json" with { type: "json" };
import { pinnedBunEnv, requirePinnedBun, resolvePinnedBun } from "../../scripts/lib/pinned-bun.mts";
import {
  resolveNativeBunTestCommand,
  resolveVitestTestCommand,
} from "../../scripts/lib/vitest-test-runtime.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const bytes = "synthetic bun executable";
const digest = createHash("sha256").update(bytes).digest("hex");

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const directory = tempDirs.make("pinned-bun-");
  const repoRoot = path.join(directory, "repo");
  fs.mkdirSync(path.join(repoRoot, "scripts/lib"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "scripts/lib/openclaw-bun.json"),
    JSON.stringify({
      tag: "test-pin",
      artifacts: { "linux-x64": { executableSha256: digest } },
    }),
  );
  const fsImpl = { ...fs };
  const readFileSync = vi.spyOn(fsImpl, "readFileSync");
  const stage = vi.fn((destination: string) => {
    fs.mkdirSync(path.join(destination, "bin"));
    fs.writeFileSync(path.join(destination, "bin/bun"), bytes, { mode: 0o755 });
  });
  const deps = { fs: fsImpl, repoRoot, stage, platform: "linux", arch: "x64" };
  const env = { XDG_CACHE_HOME: directory };
  const command = path.join(directory, "openclaw/bun/test-pin/linux-x64/bin/bun");
  const stamp = path.join(path.dirname(path.dirname(command)), "verified.json");
  return { deps, env, command, stamp, directory, readFileSync, stage, stderr };
}

describe("pinned Bun resolution", () => {
  it.each([undefined, "1"])("uses an explicit executable with CI=%s without staging", (CI) => {
    const { env, deps, directory, stage, readFileSync } = fixture();
    const command = path.join(directory, "custom-bun");
    fs.writeFileSync(command, bytes, { mode: 0o755 });
    expect(resolvePinnedBun({ ...env, CI, OPENCLAW_BUN_PATH: command }, deps)).toEqual({ command });
    expect(stage).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
    expect(
      resolvePinnedBun({ ...env, CI, OPENCLAW_BUN_PATH: `${command}-missing` }, deps).reason,
    ).toContain("OPENCLAW_BUN_PATH is not executable");
    expect(stage).not.toHaveBeenCalled();
  });

  it.each(["1", "true", "custom", "0"])("uses workflow-provisioned Bun with CI=%s", (CI) => {
    const { env, deps, stage, readFileSync, stderr } = fixture();
    const ciEnv = {
      ...env,
      CI,
      OPENCLAW_VITEST_RUNTIME: "bun",
      PATH: "/workflow/bun/bin:/usr/bin",
    };
    expect(resolvePinnedBun(ciEnv, deps)).toEqual({ command: "bun" });
    expect(pinnedBunEnv("bun", ciEnv)).toEqual({ PATH: ciEnv.PATH });
    expect(stage).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "false"])(
    "stages once with CI=%s, then silently reuses the cache",
    (CI) => {
      const { env, deps, command, stamp, stage, readFileSync, stderr } = fixture();
      const localEnv = { ...env, CI };
      expect(resolvePinnedBun(localEnv, deps)).toEqual({ command });
      expect(stage).toHaveBeenCalledOnce();
      expect(stderr).toHaveBeenCalledExactlyOnceWith(
        "[openclaw] Staging pinned Bun fork test-pin (one-time download)…",
      );
      expect(stderr).toHaveBeenCalledBefore(stage);
      expect(JSON.parse(fs.readFileSync(stamp, "utf8"))).toMatchObject({
        executableSha256: digest,
        size: Buffer.byteLength(bytes),
      });
      readFileSync.mockClear();
      expect(resolvePinnedBun(localEnv, deps)).toEqual({ command });
      expect(stage).toHaveBeenCalledOnce();
      expect(stderr).toHaveBeenCalledOnce();
      expect(readFileSync.mock.calls.some(([file]) => file === command)).toBe(false);
    },
  );

  it.each(["missing", "mtime", "hash"])("rehashes a %s stamp before reusing the cache", (kind) => {
    const { env, deps, command, stamp, stage, readFileSync } = fixture();
    resolvePinnedBun(env, deps);
    if (kind === "missing") {
      fs.unlinkSync(stamp);
    } else {
      const metadata = JSON.parse(fs.readFileSync(stamp, "utf8"));
      if (kind === "mtime") {
        metadata.mtimeMs = 0;
      } else {
        metadata.executableSha256 = "old-pin";
      }
      fs.writeFileSync(stamp, JSON.stringify(metadata));
    }
    readFileSync.mockClear();
    expect(resolvePinnedBun(env, deps)).toEqual({ command });
    expect(readFileSync.mock.calls.some(([file]) => file === command)).toBe(true);
    expect(stage).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(stamp, "utf8"))).toMatchObject({
      executableSha256: digest,
      mtimeMs: fs.statSync(command).mtimeMs,
    });
  });

  it("replaces damaged cached bytes through the stager", () => {
    const { env, deps, command, stage } = fixture();
    resolvePinnedBun(env, deps);
    fs.writeFileSync(command, "damaged");
    expect(resolvePinnedBun(env, deps)).toEqual({ command });
    expect(stage).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(command, "utf8")).toBe(bytes);
  });

  it.each([
    { failure: new Error("checksum mismatch\nadditional details"), cause: "checksum mismatch" },
    { failure: new Error("permission denied\r\nadditional details"), cause: "permission denied" },
  ])("reports stage failure ($cause) on one line and cleans up", ({ failure, cause }) => {
    const { env, deps, command, stage } = fixture();
    stage.mockImplementation(() => {
      throw failure;
    });
    expect(resolvePinnedBun(env, deps)).toEqual({
      reason: `could not stage the pinned fork: ${cause}`,
    });
    expect(fs.existsSync(command)).toBe(false);
    expect(fs.readdirSync(path.dirname(path.dirname(command)))).toEqual(["bin"]);
  });

  it.each([
    { platform: "win32", arch: "x64" },
    { platform: "linux", arch: "s390x" },
  ])("does not stage unsupported $platform-$arch", (platform) => {
    const { env, deps, stage } = fixture();
    expect(resolvePinnedBun(env, { ...deps, ...platform }).reason).toMatch(
      /unsupported platform|no pinned artifact/u,
    );
    expect(stage).not.toHaveBeenCalled();
  });

  it("uses the home cache when XDG_CACHE_HOME is unset", () => {
    const { deps, directory } = fixture();
    expect(resolvePinnedBun({}, { ...deps, homedir: () => directory })).toEqual({
      command: path.join(directory, ".cache/openclaw/bun/test-pin/linux-x64/bin/bun"),
    });
  });
});

describe("CI Bun revision admission", () => {
  const ciEnv = {
    CI: "1",
    GITHUB_JOB: "node-test-shard",
    OPENCLAW_BUN_PATH: process.execPath,
    OPENCLAW_VITEST_RUNTIME: "bun",
  };
  const callers = [
    {
      name: "Vitest",
      resolve: (env: NodeJS.ProcessEnv) =>
        resolveVitestTestCommand(["node_modules/vitest/vitest.mjs", "run"], env).command,
    },
    {
      name: "native Bun",
      resolve: (env: NodeJS.ProcessEnv) =>
        resolveNativeBunTestCommand(["./fixture.test.ts"], undefined, env).command,
    },
  ];

  it.each(callers)(
    "admits the pinned revision before constructing a $name launch",
    ({ resolve }) => {
      vi.spyOn(childProcess, "execFileSync").mockReturnValue(`${pin.revision}\n`);
      expect(resolve(ciEnv)).toBe(process.execPath);
    },
  );

  it.each(callers)(
    "rejects a different revision before constructing a $name launch",
    ({ resolve }) => {
      vi.spyOn(childProcess, "execFileSync").mockReturnValue("1.0.0+unqualified\n");
      expect(() => resolve(ciEnv)).toThrow(
        `CI job node-test-shard: Bun revision verification failed: expected ${pin.revision}, received "1.0.0+unqualified". Run .github/actions/setup-test-bun before tests.`,
      );
    },
  );

  it("reports a missing workflow-provisioned Bun with its job name", () => {
    vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
      throw new Error("spawnSync bun ENOENT");
    });
    expect(() => requirePinnedBun({ CI: "1", GITHUB_JOB: "ui-test" })).toThrow(
      "CI job ui-test: Bun revision verification failed: spawnSync bun ENOENT. Run .github/actions/setup-test-bun before tests.",
    );
  });

  it("identifies an unavailable explicit override and preserves local override behavior", () => {
    expect(() => requirePinnedBun({ ...ciEnv, OPENCLAW_BUN_PATH: "/missing/bun" })).toThrow(
      "CI job node-test-shard: Bun fork unavailable",
    );
    const execute = vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
      throw new Error("must not probe local overrides");
    });
    expect(requirePinnedBun({ CI: "false", OPENCLAW_BUN_PATH: process.execPath })).toBe(
      process.execPath,
    );
    expect(resolveVitestTestCommand(["scripts/prepare.mts"], ciEnv).command).toBe(process.execPath);
    expect(execute).not.toHaveBeenCalled();
  });
});
