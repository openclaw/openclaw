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
const npmVersion = "11.20.0";
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const tarball = `https://registry.npmjs.org/openclaw/-/openclaw-${version}.tgz`;

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

function fixture(options: { annotatedTag?: boolean } = {}) {
  const root = tempDirs.make("ios-release-gateway-");
  const selectionDir = path.join(root, "selection");
  const installDir = path.join(root, "install");
  const signal = new AbortController().signal;
  const state = {
    metadata: { name: "openclaw", version, dist: { integrity, tarball } },
    sourceSha,
    npmVersion,
    installedVersion: version,
    installedCommit: sourceSha,
    installExitCode: 0,
    cancelInstall: undefined as AbortController | undefined,
  };
  const lock = {
    name: "ios-release-gateway-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { openclaw: version } },
      "node_modules/openclaw": {
        version,
        resolved: tarball,
        integrity,
        dependencies: { "fixture-transitive": "^1.0.0" },
      },
      "node_modules/fixture-transitive": {
        version: "1.2.3",
        resolved: "https://registry.npmjs.org/fixture-transitive/-/fixture-transitive-1.2.3.tgz",
        integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}`,
      },
    },
  };
  const requests: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    const authorization = new Headers(init?.headers).get("Authorization");
    if (url === "https://registry.npmjs.org/openclaw/latest") {
      expect(authorization).toBeNull();
      return Response.json(state.metadata);
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
  command.mockImplementation(async (operation: RunManagedCommandOptions) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new ChildProcess();
    expect(operation.env).not.toHaveProperty("GH_TOKEN");
    expect(operation.env).not.toHaveProperty("GITHUB_TOKEN");
    child.stdout = stdout;
    child.stderr = stderr;
    operation.onReady?.(child);
    try {
      expect(path.basename(operation.bin)).toMatch(/^npm(?:\.cmd)?$/u);
      const args = operation.args ?? [];
      if (args.includes("--version")) {
        stdout.write(`${state.npmVersion}\n`);
        return 0;
      }
      const cwd = operation.cwd;
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
        writeJson(path.join(cwd, "package-lock.json"), lock);
        return 0;
      }
      if (args.includes("ci")) {
        installs.push({
          packageBytes: readFileSync(path.join(cwd, "package.json"), "utf8"),
          lockBytes: readFileSync(path.join(cwd, "package-lock.json"), "utf8"),
        });
        if (state.cancelInstall) {
          expect(operation.signal?.aborted).toBe(false);
          state.cancelInstall.abort(new Error("fixture install cancellation"));
          expect(operation.signal?.aborted).toBe(true);
          operation.signal?.throwIfAborted();
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
  return { root, selectionDir, installDir, signal, state, lock, fetch, requests, installs };
}

describe("iOS stable Gateway package qualification", () => {
  it.each([false, true])(
    "freezes the published selection and replays its exact dependency graph (annotated tag: %s)",
    async (annotatedTag) => {
      vi.stubEnv("GH_TOKEN", annotatedTag ? "synthetic-ios-github-token" : "");
      vi.stubEnv("GITHUB_TOKEN", "");
      const f = fixture({ annotatedTag });
      const selected = await selectIOSReleaseGateway({
        selectionDir: f.selectionDir,
        targetSha,
        signal: f.signal,
      });
      expect(selected).toMatchObject({ targetSha, version, sourceSha, integrity, tarball });
      const packageBytes = readFileSync(path.join(f.selectionDir, "package.json"), "utf8");
      const lockBytes = readFileSync(path.join(f.selectionDir, "package-lock.json"), "utf8");
      expect(selected).toMatchObject({
        packageSha256: createHash("sha256").update(packageBytes).digest("hex"),
        lockSha256: createHash("sha256").update(lockBytes).digest("hex"),
      });
      expect(f.requests).toHaveLength(annotatedTag ? 3 : 2);
      f.fetch.mockImplementation(async () => {
        throw new Error("The registry and moving latest tag are unavailable during replay");
      });
      const prepared = await prepareIOSReleaseGateway({
        selectionDir: f.selectionDir,
        installDir: f.installDir,
        signal: f.signal,
        targetSha,
      });
      expect(prepared.identity).toEqual(selected);
      expect(prepared.cwd).toBe(path.join(f.installDir, "node_modules", "openclaw"));
      expect(prepared.entrypoint).toEqual([path.join(prepared.cwd, "openclaw.mjs")]);
      expect(f.installs).toEqual([{ packageBytes, lockBytes }]);
      expect(f.fetch).toHaveBeenCalledTimes(annotatedTag ? 3 : 2);
      expect(
        command.mock.calls.filter(([operation]) => operation.args?.includes("--package-lock-only")),
      ).toHaveLength(1);
    },
  );

  it.each([
    ["integrity", /Invalid string|Invalid.*format|regular stable OpenClaw release/u],
    ["source SHA", /Invalid string|Invalid.*format|regular stable OpenClaw release/u],
    ["prerelease", /Invalid string|Invalid.*format|regular stable OpenClaw release/u],
    ["nonregistry tarball", /tarball|registry|qualification target/u],
    ["lock integrity", /package lock does not match/u],
  ] as const)(
    "rejects invalid published %s before installing a Gateway",
    async (invalid, error) => {
      const f = fixture();
      if (invalid === "integrity") {
        f.state.metadata.dist.integrity = "not-an-integrity";
      } else if (invalid === "source SHA") {
        f.state.sourceSha = "main";
      } else if (invalid === "prerelease") {
        f.state.metadata.version = "2026.9.8-beta.1";
      } else if (invalid === "nonregistry tarball") {
        const wrongTarball = "https://example.invalid/openclaw.tgz";
        f.state.metadata.dist.tarball = wrongTarball;
        f.lock.packages["node_modules/openclaw"].resolved = wrongTarball;
      } else {
        f.lock.packages["node_modules/openclaw"].integrity =
          `sha512-${Buffer.alloc(64, 3).toString("base64")}`;
      }
      await expect(
        prepareIOSReleaseGateway({
          selectionDir: f.selectionDir,
          installDir: f.installDir,
          signal: f.signal,
          targetSha,
        }),
      ).rejects.toThrow(error);
      expect(f.installs).toHaveLength(0);
      expect(existsSync(path.join(f.selectionDir, "selection.json"))).toBe(false);
    },
  );

  it("refuses an incomplete saved selection without replacing it with latest", async () => {
    const f = fixture();
    mkdirSync(f.selectionDir);
    await expect(
      selectIOSReleaseGateway({ selectionDir: f.selectionDir, targetSha, signal: f.signal }),
    ).rejects.toThrow(/ENOENT/u);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it.each(["package.json", "package-lock.json", "target SHA", "Node", "npm"])(
    "refuses changed saved %s instead of reselecting latest",
    async (invalid) => {
      const f = fixture();
      await selectIOSReleaseGateway({ selectionDir: f.selectionDir, targetSha, signal: f.signal });
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
        prepareIOSReleaseGateway({
          selectionDir: f.selectionDir,
          installDir: f.installDir,
          signal: f.signal,
          targetSha: invalid === "target SHA" ? "4".repeat(40) : targetSha,
        }),
      ).rejects.toThrow(
        /manifests changed|qualification target|Node version and platform|npm version/u,
      );
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.installs).toHaveLength(0);
    },
  );

  it.each(["version", "source"])(
    "rejects an installed package with the wrong %s",
    async (wrong) => {
      const f = fixture();
      if (wrong === "version") {
        f.state.installedVersion = "2026.9.6";
      } else {
        f.state.installedCommit = "4".repeat(40);
      }
      await expect(
        prepareIOSReleaseGateway({
          selectionDir: f.selectionDir,
          installDir: f.installDir,
          signal: f.signal,
          targetSha,
        }),
      ).rejects.toThrow(/Installed Gateway identity differs/);
      expect(f.installs).toHaveLength(1);
    },
  );

  it.each(["failure", "cancellation"])(
    "propagates npm ci %s without a source fallback",
    async (outcome) => {
      const f = fixture();
      const abort = new AbortController();
      if (outcome === "failure") {
        f.state.installExitCode = 23;
      } else {
        f.state.cancelInstall = abort;
      }
      await expect(
        prepareIOSReleaseGateway({
          selectionDir: f.selectionDir,
          installDir: f.installDir,
          targetSha,
          signal: abort.signal,
        }),
      ).rejects.toThrow(outcome === "failure" ? /23/ : /cancellation/);
      expect(f.installs).toHaveLength(1);
      expect(existsSync(path.join(f.selectionDir, "selection.json"))).toBe(true);
      expect(command.mock.calls.at(-1)?.[0].args).toContain("ci");
    },
  );
});
