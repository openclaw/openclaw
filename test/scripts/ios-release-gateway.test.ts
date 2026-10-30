import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareIOSReleaseGateway,
  selectIOSReleaseGateway,
} from "../../scripts/lib/ios-release-gateway.js";
import type { RunManagedCommandOptions } from "../../scripts/lib/managed-child-process.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const command = vi.hoisted(() => vi.fn<(options: RunManagedCommandOptions) => Promise<number>>());
vi.mock("../../scripts/lib/managed-child-process.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mjs")>()),
  runManagedCommand: command,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const targetSha = "1".repeat(40);
const sourceSha = "2".repeat(40);
const tagSha = "3".repeat(40);
const version = "2026.9.7";
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const tarball = `https://registry.npmjs.org/openclaw/-/openclaw-${version}.tgz`;
const identity = { targetSha, version, sourceSha, integrity, tarball };
const invalidRelease = /Invalid string|Invalid.*format|regular stable OpenClaw release/u;
const invalidTarball = /tarball|registry|qualification target/u;
const wrongIntegrity = `sha512-${Buffer.alloc(64, 3).toString("base64")}`;

afterEach(() => {
  command.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readManifests(dir: string) {
  return {
    packageBytes: readFileSync(path.join(dir, "package.json"), "utf8"),
    lockBytes: readFileSync(path.join(dir, "package-lock.json"), "utf8"),
  };
}

function fixture(options: { annotatedTag?: boolean } = {}) {
  const root = tempDirs.make("ios-release-gateway-");
  const selectionDir = path.join(root, "selection");
  const installDir = path.join(root, "install");
  const state = {
    ...identity,
    lockIntegrity: integrity,
    npmVersion: "11.20.0",
    installedVersion: version,
    installedCommit: sourceSha,
    installExitCode: 0,
    cancelInstall: undefined as AbortController | undefined,
  };
  const lock = () => ({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { openclaw: version } },
      "node_modules/openclaw": {
        version,
        resolved: state.tarball,
        integrity: state.lockIntegrity,
        dependencies: { "fixture-transitive": "^1.0.0" },
      },
      "node_modules/fixture-transitive": {
        version: "1.2.3",
        resolved: "https://registry.npmjs.org/fixture-transitive/-/fixture-transitive-1.2.3.tgz",
        integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}`,
      },
    },
  });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("Authorization");
    if (url === "https://registry.npmjs.org/openclaw/latest") {
      expect(authorization).toBeNull();
      return Response.json({
        name: "openclaw",
        version: state.version,
        dist: { integrity: state.integrity, tarball: state.tarball },
      });
    }
    if (
      process.env.GH_TOKEN === "synthetic-ios-github-token" &&
      authorization !== "Bearer synthetic-ios-github-token"
    ) {
      return Response.json({ message: "API rate limit exceeded" }, { status: 403 });
    }
    if (url.endsWith(`/tags/v${version}`)) {
      return Response.json({
        object: {
          type: options.annotatedTag ? "tag" : "commit",
          sha: options.annotatedTag ? tagSha : state.sourceSha,
        },
      });
    }
    if (options.annotatedTag && url.endsWith(`/git/tags/${tagSha}`)) {
      return Response.json({ object: { type: "commit", sha: state.sourceSha } });
    }
    throw new Error(`Unexpected metadata request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  const installs: Array<{ packageBytes: string; lockBytes: string }> = [];
  command.mockImplementation(async ({ env, bin, args = [], cwd, signal, onReady }) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new ChildProcess();
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    child.stdout = stdout;
    child.stderr = stderr;
    onReady?.(child);
    try {
      expect(path.basename(bin)).toMatch(/^npm(?:\.cmd)?$/u);
      if (args.includes("--version")) {
        stdout.write(`${state.npmVersion}\n`);
        return 0;
      }
      if (!cwd) {
        throw new Error("npm requires an isolated working directory");
      }
      if (args.includes("--package-lock-only")) {
        expect(args).toEqual(
          expect.arrayContaining(["install", "--ignore-scripts", "--no-audit", "--no-fund"]),
        );
        expect(readJson(path.join(cwd, "package.json")).dependencies).toEqual({
          openclaw: version,
        });
        writeJson(path.join(cwd, "package-lock.json"), lock());
        return 0;
      }
      if (args.includes("ci")) {
        installs.push(readManifests(cwd));
        if (state.cancelInstall) {
          expect(signal?.aborted).toBe(false);
          state.cancelInstall.abort(new Error("fixture install cancellation"));
          expect(signal?.aborted).toBe(true);
          signal?.throwIfAborted();
        }
        if (state.installExitCode) {
          return state.installExitCode;
        }
        const packageRoot = path.join(cwd, "node_modules", "openclaw");
        mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
        writeJson(path.join(packageRoot, "package.json"), {
          name: "openclaw",
          version: state.installedVersion,
          bin: { openclaw: "openclaw.mjs" },
        });
        writeJson(path.join(packageRoot, "dist", "build-info.json"), {
          version: state.installedVersion,
          commit: state.installedCommit,
        });
        writeFileSync(path.join(packageRoot, "openclaw.mjs"), "// synthetic package entrypoint\n");
        return 0;
      }
      throw new Error(`Unexpected npm command: ${args.join(" ")}`);
    } finally {
      stdout.end();
      stderr.end();
    }
  });
  const selection = { selectionDir, targetSha, signal: new AbortController().signal };
  const select = () => selectIOSReleaseGateway(selection);
  const prepare = (overrides: Partial<Parameters<typeof prepareIOSReleaseGateway>[0]> = {}) =>
    prepareIOSReleaseGateway({ ...selection, installDir, ...overrides });
  return { selectionDir, installDir, state, fetch, installs, select, prepare };
}

describe("iOS stable Gateway package qualification", () => {
  it.each([false, true])("replays the frozen graph (annotated tag: %s)", async (annotatedTag) => {
    vi.stubEnv("GH_TOKEN", annotatedTag ? "synthetic-ios-github-token" : "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const f = fixture({ annotatedTag });
    const selected = await f.select();
    const { packageBytes, lockBytes } = readManifests(f.selectionDir);
    expect(selected).toMatchObject({
      ...identity,
      packageSha256: createHash("sha256").update(packageBytes).digest("hex"),
      lockSha256: createHash("sha256").update(lockBytes).digest("hex"),
    });
    expect(f.fetch).toHaveBeenCalledTimes(annotatedTag ? 3 : 2);
    f.fetch.mockImplementation(async () => {
      throw new Error("The registry and moving latest tag are unavailable during replay");
    });
    const prepared = await f.prepare();
    expect(prepared.identity).toEqual(selected);
    expect(prepared.cwd).toBe(path.join(f.installDir, "node_modules", "openclaw"));
    expect(prepared.entrypoint).toEqual([path.join(prepared.cwd, "openclaw.mjs")]);
    expect(f.installs).toEqual([{ packageBytes, lockBytes }]);
    expect(f.fetch).toHaveBeenCalledTimes(annotatedTag ? 3 : 2);
    expect(
      command.mock.calls.filter(([operation]) => operation.args?.includes("--package-lock-only")),
    ).toHaveLength(1);
  });

  it.each([
    ["integrity", { integrity: "not-an-integrity" }, invalidRelease],
    ["source SHA", { sourceSha: "main" }, invalidRelease],
    ["prerelease", { version: "2026.9.8-beta.1" }, invalidRelease],
    ["nonregistry tarball", { tarball: "https://example.invalid/openclaw.tgz" }, invalidTarball],
    ["lock integrity", { lockIntegrity: wrongIntegrity }, /package lock does not match/u],
  ] as const)("rejects invalid published %s", async (_name, overrides, error) => {
    const f = fixture();
    Object.assign(f.state, overrides);
    await expect(f.prepare()).rejects.toThrow(error);
    expect(f.installs).toHaveLength(0);
    expect(existsSync(path.join(f.selectionDir, "selection.json"))).toBe(false);
  });

  it("refuses an incomplete saved selection without replacing it with latest", async () => {
    const f = fixture();
    mkdirSync(f.selectionDir);
    await expect(f.select()).rejects.toThrow(/ENOENT/u);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it.each(["package.json", "package-lock.json", "target SHA", "Node", "npm"])(
    "refuses changed saved %s without reselecting",
    async (invalid) => {
      const f = fixture();
      await f.select();
      f.fetch.mockClear();
      const manifestPath = path.join(f.selectionDir, "selection.json");
      if (invalid === "package.json" || invalid === "package-lock.json") {
        writeFileSync(path.join(f.selectionDir, invalid), "{}\n");
      } else if (invalid === "npm") {
        f.state.npmVersion = "11.21.0";
      } else if (invalid === "Node") {
        writeJson(manifestPath, { ...readJson(manifestPath), nodeVersion: "v0.0.0" });
      }
      await expect(
        f.prepare({ targetSha: invalid === "target SHA" ? "4".repeat(40) : targetSha }),
      ).rejects.toThrow(
        /manifests changed|qualification target|Node version and platform|npm version/u,
      );
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.installs).toHaveLength(0);
    },
  );

  it.each(["version", "source"])("rejects wrong installed %s", async (wrong) => {
    const f = fixture();
    if (wrong === "version") {
      f.state.installedVersion = "2026.9.6";
    } else {
      f.state.installedCommit = "4".repeat(40);
    }
    await expect(f.prepare()).rejects.toThrow(/Installed Gateway identity differs/);
    expect(f.installs).toHaveLength(1);
  });

  it.each(["failure", "cancellation"])("propagates npm ci %s without fallback", async (outcome) => {
    const f = fixture();
    const abort = new AbortController();
    if (outcome === "failure") {
      f.state.installExitCode = 23;
    } else {
      f.state.cancelInstall = abort;
    }
    await expect(f.prepare({ signal: abort.signal })).rejects.toThrow(
      outcome === "failure" ? /23/ : /cancellation/,
    );
    expect(f.installs).toHaveLength(1);
    expect(existsSync(path.join(f.selectionDir, "selection.json"))).toBe(true);
    expect(command.mock.calls.at(-1)?.[0].args).toContain("ci");
  });
});
