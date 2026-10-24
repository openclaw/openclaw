import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
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

function expectUnused(...mocks: MockInstance[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function fixture() {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const directory = tempDirs.make("pinned-bun-");
  const repoRoot = path.join(directory, "repo");
  fs.mkdirSync(path.join(repoRoot, "scripts/lib"), { recursive: true });
  const manifest = { tag: "test-pin", artifacts: { "linux-x64": { executableSha256: digest } } };
  fs.writeFileSync(path.join(repoRoot, "scripts/lib/openclaw-bun.json"), JSON.stringify(manifest));
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
  const resolve = (extraEnv: NodeJS.ProcessEnv = {}, extraDeps: Partial<typeof deps> = {}) =>
    resolvePinnedBun({ ...env, ...extraEnv }, { ...deps, ...extraDeps });
  const readStamp = () => JSON.parse(fs.readFileSync(stamp, "utf8"));
  return { deps, resolve, command, stamp, directory, readFileSync, readStamp, stage, stderr };
}

it.each([undefined, "1"])("uses an explicit executable with CI=%s without staging", (CI) => {
  const { resolve, directory, stage, readFileSync } = fixture();
  const command = path.join(directory, "custom-bun");
  fs.writeFileSync(command, bytes, { mode: 0o755 });
  expect(resolve({ CI, OPENCLAW_BUN_PATH: command })).toEqual({ command });
  expectUnused(stage, readFileSync);
  expect(resolve({ CI, OPENCLAW_BUN_PATH: `${command}-missing` }).reason).toContain(
    "OPENCLAW_BUN_PATH is not executable",
  );
  expect(stage).not.toHaveBeenCalled();
});

it.each(["1", "true", "custom", "0"])("uses workflow-provisioned Bun with CI=%s", (CI) => {
  const { resolve, stage, readFileSync, stderr } = fixture();
  const ciEnv = { CI, OPENCLAW_VITEST_RUNTIME: "bun", PATH: "/workflow/bun/bin:/usr/bin" };
  expect(resolve(ciEnv)).toEqual({ command: "bun" });
  expect(pinnedBunEnv("bun", ciEnv)).toEqual({ PATH: ciEnv.PATH });
  expectUnused(stage, readFileSync, stderr);
});

it.each([undefined, "", "false"])("stages and silently reuses cache with CI=%s", (CI) => {
  const { resolve, command, readStamp, stage, readFileSync, stderr } = fixture();
  expect(resolve({ CI })).toEqual({ command });
  expect(stage).toHaveBeenCalledOnce();
  expect(stderr).toHaveBeenCalledExactlyOnceWith(
    "[openclaw] Staging pinned Bun fork test-pin (one-time download)…",
  );
  expect(stderr).toHaveBeenCalledBefore(stage);
  expect(readStamp()).toMatchObject({
    executableSha256: digest,
    size: Buffer.byteLength(bytes),
  });
  readFileSync.mockClear();
  expect(resolve({ CI })).toEqual({ command });
  expect(stage).toHaveBeenCalledOnce();
  expect(stderr).toHaveBeenCalledOnce();
  expect(readFileSync.mock.calls.some(([file]) => file === command)).toBe(false);
});

it.each(["missing", "mtime", "hash"])("rehashes a %s stamp before reusing the cache", (kind) => {
  const { resolve, command, stamp, stage, readFileSync, readStamp } = fixture();
  resolve();
  if (kind === "missing") {
    fs.unlinkSync(stamp);
  } else {
    const changed = kind === "mtime" ? { mtimeMs: 0 } : { executableSha256: "old-pin" };
    fs.writeFileSync(stamp, JSON.stringify({ ...readStamp(), ...changed }));
  }
  readFileSync.mockClear();
  expect(resolve()).toEqual({ command });
  expect(readFileSync.mock.calls.some(([file]) => file === command)).toBe(true);
  expect(stage).toHaveBeenCalledOnce();
  expect(readStamp()).toMatchObject({
    executableSha256: digest,
    mtimeMs: fs.statSync(command).mtimeMs,
  });
});

it("replaces damaged cached bytes through the stager", () => {
  const { resolve, command, stage } = fixture();
  resolve();
  fs.writeFileSync(command, "damaged");
  expect(resolve()).toEqual({ command });
  expect(stage).toHaveBeenCalledTimes(2);
  expect(fs.readFileSync(command, "utf8")).toBe(bytes);
});

it.each([
  { failure: new Error("checksum mismatch\nadditional details"), cause: "checksum mismatch" },
  { failure: new Error("permission denied\r\nadditional details"), cause: "permission denied" },
])("reports stage failure ($cause) on one line and cleans up", ({ failure, cause }) => {
  const { resolve, command, stage } = fixture();
  stage.mockImplementation(() => {
    throw failure;
  });
  expect(resolve()).toEqual({ reason: `could not stage the pinned fork: ${cause}` });
  expect(fs.existsSync(command)).toBe(false);
  expect(fs.readdirSync(path.dirname(path.dirname(command)))).toEqual(["bin"]);
});

it.each([
  { platform: "win32", arch: "x64" },
  { platform: "linux", arch: "s390x" },
])("does not stage unsupported $platform-$arch", (platform) => {
  const { resolve, stage } = fixture();
  expect(resolve({}, platform).reason).toMatch(/unsupported platform|no pinned artifact/u);
  expect(stage).not.toHaveBeenCalled();
});

it("uses the home cache when XDG_CACHE_HOME is unset", () => {
  const { deps, directory } = fixture();
  expect(resolvePinnedBun({}, { ...deps, homedir: () => directory })).toEqual({
    command: path.join(directory, ".cache/openclaw/bun/test-pin/linux-x64/bin/bun"),
  });
});
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

it.each(callers)("admits pinned revision for $name", ({ resolve }) => {
  vi.spyOn(childProcess, "execFileSync").mockReturnValue(`${pin.revision}\n`);
  expect(resolve(ciEnv)).toBe(process.execPath);
});

it.each(callers)("rejects wrong revision for $name", ({ resolve }) => {
  vi.spyOn(childProcess, "execFileSync").mockReturnValue("1.0.0+unqualified\n");
  expect(() => resolve(ciEnv)).toThrow(
    `CI job node-test-shard: Bun revision verification failed: expected ${pin.revision}, received "1.0.0+unqualified". Run .github/actions/setup-test-bun before tests.`,
  );
});

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
