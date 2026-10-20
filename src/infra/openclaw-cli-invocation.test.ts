import { mkdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  filterOpenClawChildExecArgv,
  resolveCurrentOpenClawCliInvocation,
} from "./openclaw-cli-invocation.js";

const requireFromHere = createRequire(import.meta.url);
const repoRoot = process.cwd();
const repoSourceEntry = path.join(repoRoot, "src", "entry.ts");
const trustedTsxLoader = pathToFileURL(requireFromHere.resolve("tsx", { paths: [repoRoot] })).href;
const sourceEnv = { TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json") };
const commandArgs = ["sessions", "export-trajectory"];
const invoke = (options: Parameters<typeof resolveCurrentOpenClawCliInvocation>[1]) =>
  resolveCurrentOpenClawCliInvocation(commandArgs, options);
const writePackage = (root: string) =>
  writeFile(path.join(root, "package.json"), '{"name":"openclaw"}');

describe("resolveCurrentOpenClawCliInvocation", () => {
  it.each(["sidecar", "foreign checkout"])(
    "uses the standalone sidecar from a %s cwd",
    async (cwdKind) => {
      await withTempDir("openclaw-cli-standalone-", async (root) => {
        const packageRoot = path.join(root, "runtime");
        await mkdir(packageRoot);
        await writePackage(packageRoot);
        const execPath = path.join(root, "openclaw");
        await writeFile(
          path.join(root, "manifest.json"),
          JSON.stringify({
            schemaVersion: 1,
            mode: "aot",
            executable: { path: "openclaw" },
            runtime: { path: "runtime" },
            openclaw: { version: "2026.10.15" },
            bun: { version: "1.3.0" },
          }),
        );
        expect(
          invoke({
            execPath,
            argv1:
              cwdKind === "sidecar"
                ? path.join(packageRoot, "openclaw.mjs")
                : "/$bunfs/root/cli.js",
            execArgv: ["--trace-warnings"],
            cwd: cwdKind === "sidecar" ? root : repoRoot,
          }),
        ).toEqual({ command: execPath, args: commandArgs, cwd: packageRoot });
      });
    },
  );

  it("keeps child runtime flags without inheriting debugger ownership", () => {
    expect(
      filterOpenClawChildExecArgv([
        "--import",
        "/loader.mjs",
        "--inspect",
        "127.0.0.1:9231",
        "--inspect-brk=0",
        "--inspect-wait=0",
        "--inspect-port",
        "9230",
        "--inspect-port=9232",
        "--trace-warnings",
      ]),
    ).toEqual(["--import", "/loader.mjs", "--trace-warnings"]);
  });

  it.each([{ tsxArgs: ["--import", "tsx"] }, { tsxArgs: ["--import=tsx"] }])(
    "pins the source parent's TSX import while preserving other runtime hooks: %j",
    ({ tsxArgs }) => {
      const runtimeArgs = ["--trace-warnings", "--import", "/other-loader.mjs"];
      const invocation = invoke({
        argv1: repoSourceEntry,
        cwd: repoRoot,
        execArgv: [...runtimeArgs, ...tsxArgs],
        execPath: resolveTestNodeExecPath(),
      });
      expect(invocation.args).toEqual([
        ...runtimeArgs,
        ...(tsxArgs.length === 2
          ? ["--import", trustedTsxLoader]
          : [`--import=${trustedTsxLoader}`]),
        repoSourceEntry,
        ...commandArgs,
      ]);
    },
  );

  it("uses the source entry directly under Bun", () => {
    expect(
      invoke({
        argv1: path.join(repoRoot, "scripts", "test-live.mts"),
        cwd: repoRoot,
        execPath: "/usr/local/bin/bun",
      }),
    ).toEqual({
      command: "/usr/local/bin/bun",
      args: ["--no-install", repoSourceEntry, ...commandArgs],
      cwd: repoRoot,
    });
  });

  it.each(["openclaw.mjs", path.join("dist", "index.js")])(
    "pins a prepared %s invocation across an installation switch",
    async (entryName) => {
      await withTempDir("openclaw-cli-release-switch-", async (root) => {
        const releaseA = path.join(await realpath(root), "release-a");
        const releaseB = path.join(await realpath(root), "release-b");
        for (const release of [releaseA, releaseB]) {
          await mkdir(path.join(release, "dist"), { recursive: true });
          await writePackage(release);
          await writeFile(path.join(release, "openclaw.mjs"), "export {};\n");
          await writeFile(path.join(release, "dist", "index.js"), "export {};\n");
        }
        const current = path.join(root, "current");
        await symlink(releaseA, current, "junction");
        const options = {
          argv1: path.join(current, entryName),
          cwd: root,
          execPath: resolveTestNodeExecPath(),
          execArgv: [],
        };
        const prepared = resolveCurrentOpenClawCliInvocation(["--version"], options);

        await unlink(current);
        await symlink(releaseB, current, "junction");

        expect(await realpath(expectDefined(prepared.args[0], "prepared CLI entry"))).toBe(
          path.join(releaseA, entryName),
        );
        expect(prepared.cwd).toBe(releaseA);
        const fresh = resolveCurrentOpenClawCliInvocation(["--version"], options);
        expect(await realpath(expectDefined(fresh.args[0], "fresh CLI entry"))).toBe(
          path.join(releaseB, entryName),
        );
        expect(fresh.cwd).toBe(releaseB);
      });
    },
  );

  it("uses the installed wrapper under Node and canonical package cwd", async () => {
    const execPath = "/usr/bin/node";
    await withTempDir("openclaw-cli-invocation-", async (packageRoot) => {
      await writePackage(packageRoot);
      const moduleUrl = pathToFileURL(path.join(packageRoot, "dist", "tui", "index.js")).href;
      expect(
        invoke({
          argv1: path.join(packageRoot, "bin", "host.mjs"),
          cwd: path.join(packageRoot, "state"),
          execPath,
          moduleUrl,
        }),
      ).toEqual({
        command: execPath,
        args: [path.join(packageRoot, "openclaw.mjs"), ...commandArgs],
        cwd: packageRoot,
      });
    });
  });

  it("does not preserve a foreign package entry", () => {
    expect(
      invoke({
        argv1: "/app/dist/index.js",
        cwd: repoRoot,
        execPath: "/usr/bin/node",
      }),
    ).toEqual({
      command: "/usr/bin/node",
      args: ["--import", trustedTsxLoader, repoSourceEntry, ...commandArgs],
      cwd: repoRoot,
      env: sourceEnv,
    });
  });
});
