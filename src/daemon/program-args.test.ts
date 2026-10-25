import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as windowsEncoding from "../infra/windows-encoding.js";

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const mocked = { ...actual, ...fsMocks };
  return { ...mocked, default: mocked };
});

import { resolveNodeRuntimeExecutable } from "../infra/node-runtime-executable.js";
import { resolveGatewayHeapNodeOptions } from "./gateway-heap.js";
import { resolveGatewayProgramArguments, resolveNodeProgramArguments } from "./program-args.js";
import { stageScheduledTask } from "./schtasks-install.js";
import { readScheduledTaskCommand } from "./schtasks-layout.js";

const originalArgv = [...process.argv];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalExecPath = process.execPath;
const validatedNodePath = "/opt/Validated Node/bin/node";
const validatedBunPath = "/opt/Validated Bun/bin/bun";
const defaultEntrypoint = path.resolve("/opt/openclaw/dist/index.js");
const missingSelectedNodeError =
  "No supported Node runtime was selected for the daemon. Install Node >=24.22.1 <25, or >=26.12.1 (Node 26 recommended), then retry.";
const missingSelectedBunError =
  "No supported Bun runtime was selected for the daemon. Install Bun 1.4.3 or newer with WAL-reset-safe node:sqlite, then retry.";

beforeEach(() => {
  vi.spyOn(os, "totalmem").mockReturnValue(64 * 1024 ** 3);
  vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
  mockEntrypoint(defaultEntrypoint);
});

afterEach(() => {
  process.argv = [...originalArgv];
  process.execPath = originalExecPath;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function mockEntrypoint(entryPath: string, execPath = "node") {
  process.argv = [execPath, entryPath];
  fsMocks.realpath.mockResolvedValue(entryPath);
  fsMocks.access.mockResolvedValue(undefined);
}

function gatewayArgs(options: Partial<Parameters<typeof resolveGatewayProgramArguments>[0]> = {}) {
  return resolveGatewayProgramArguments({
    port: 18789,
    runtime: "node",
    runtimePath: validatedNodePath,
    ...options,
  });
}
function nodeArgs(options: Partial<Parameters<typeof resolveNodeProgramArguments>[0]> = {}) {
  return resolveNodeProgramArguments({
    host: "gateway.example",
    port: 18789,
    runtime: "node",
    runtimePath: validatedNodePath,
    ...options,
  });
}
const gatewayTail = ["gateway", "--port", "18789"];
const nodeTail = ["node", "run", "--host", "gateway.example", "--port", "18789"];
describe("resolveGatewayProgramArguments", () => {
  it("installs the requested start-mode override once", async () => {
    const { programArguments } = await gatewayArgs({
      allowUnconfigured: true,
      existingCommand: {
        programArguments: [validatedNodePath, defaultEntrypoint, "gateway", "--allow-unconfigured"],
      },
    });

    expect(programArguments.slice(programArguments.indexOf("gateway"))).toEqual([
      ...gatewayTail,
      "--allow-unconfigured",
    ]);
  });

  it.skipIf(
    resolveNodeRuntimeExecutable({ requiredFlag: "--max-old-space-size" }) !== originalExecPath,
  )("sizes only the Gateway in an ordinary Node spawn tree", async () => {
    mockEntrypoint(defaultEntrypoint, originalExecPath);
    const { programArguments } = await gatewayArgs({ runtimePath: originalExecPath });
    const measurement = "console.log(require('node:v8').getHeapStatistics().heap_size_limit)";
    const environment = { NODE_OPTIONS: resolveGatewayHeapNodeOptions(undefined) };
    const nativeDefault = spawnSync(originalExecPath, ["-e", measurement], {
      env: environment,
      encoding: "utf8",
    });
    const parent = spawnSync(
      originalExecPath,
      [
        ...programArguments.slice(1, programArguments.indexOf(defaultEntrypoint)),
        "-e",
        `const child = require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(measurement)}], { encoding: 'utf8' });
       if (child.status !== 0) throw new Error(child.stderr);
       console.log(JSON.stringify({ heap: require('node:v8').getHeapStatistics().heap_size_limit, used: process.memoryUsage().heapUsed, child: Number(child.stdout), options: process.env.NODE_OPTIONS }));`,
      ],
      { env: environment, encoding: "utf8" },
    );
    expect(nativeDefault.status, nativeDefault.stderr).toBe(0);
    expect(parent.status, parent.stderr).toBe(0);
    const result = JSON.parse(parent.stdout);
    expect(result.heap).toBeGreaterThanOrEqual(16384 * 1024 ** 2);
    expect(result.used).toBeLessThan(64 * 1024 ** 2);
    expect(result.child).toBe(Number(nativeDefault.stdout));
    expect(result.options).toBe("");
  });

  it("ignores installer execArgv and keeps native defaults when capacity is unknown", async () => {
    vi.spyOn(os, "totalmem").mockReturnValue(Number.NaN);
    const originalExecArgv = process.execArgv;
    process.execArgv = ["--max-old-space-size=24576", "--require=/tmp/preload.js"];
    try {
      const result = await gatewayArgs();
      expect(result.programArguments).toEqual([
        validatedNodePath,
        defaultEntrypoint,
        ...gatewayTail,
      ]);
    } finally {
      process.execArgv = originalExecArgv;
    }
  });

  it("keeps the normalized dist path when pnpm ownership cannot be verified", async () => {
    mockEntrypoint(path.resolve("/package/dist/entry.js"));
    fsMocks.realpath.mockResolvedValue(
      path.resolve("/package/.pnpm/openclaw@1/node_modules/openclaw/dist/entry.js"),
    );
    expect((await gatewayArgs()).programArguments[2]).toBe(path.resolve("/package/dist/index.js"));
  });

  it("falls back to node_modules package dist when .bin path is not resolved", async () => {
    const argv1 = path.resolve("/tmp/.npm/_npx/63c3/node_modules/.bin/openclaw");
    const indexPath = path.resolve("/tmp/.npm/_npx/63c3/node_modules/openclaw/dist/index.js");
    process.argv = ["node", argv1];
    fsMocks.realpath.mockRejectedValue(new Error("no realpath"));
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === indexPath) {
        return;
      }
      throw new Error("missing");
    });

    const result = await gatewayArgs();

    expect(result.programArguments).toEqual([
      validatedNodePath,
      "--max-old-space-size=16384",
      indexPath,
      ...gatewayTail,
    ]);
  });

  it.each([
    ["node", true],
    ["bun", false],
    ["bun", true],
  ] as const)("runs the %s Gateway (dev=%s)", async (runtime, dev) => {
    const root = path.resolve(dev ? "/repo" : "/opt/openclaw");
    const source = path.join(root, dev ? "src/index.ts" : "dist/entry.js");
    const entry = path.join(root, dev ? "src/entry.ts" : "dist/index.js");
    const runtimePath = runtime === "node" ? validatedNodePath : validatedBunPath;
    mockEntrypoint(source, runtime === "node" ? "/usr/local/bin/node" : validatedBunPath);
    const result = await gatewayArgs({ dev, runtime, runtimePath });
    expect(result.programArguments).toEqual([
      runtimePath,
      ...(runtime === "node"
        ? ["--max-old-space-size=16384", "--import", "tsx"]
        : ["--no-install"]),
      entry,
      ...gatewayTail,
    ]);
    if (dev) {
      expect(result.workingDirectory).toBe(root);
    }
  });

  it.each([
    ["node", missingSelectedNodeError],
    ["bun", missingSelectedBunError],
  ] as const)("rejects a blank selected %s path", async (runtime, error) => {
    if (runtime === "node") {
      process.execPath = "/usr/local/bin/bun";
    }
    await expect(
      nodeArgs({ runtime, dev: runtime === "node", runtimePath: " \t " }),
    ).rejects.toThrow(error);
  });

  it.each([true, false])(
    "requires an executable wrapper from Bun (executable=%s)",
    async (executable) => {
      const wrapperPath = path.resolve("/usr/local/bin/openclaw-doppler");
      process.execPath = "/usr/local/bin/bun";
      fsMocks.stat.mockResolvedValue({ isFile: () => true } as never);
      if (!executable) {
        fsMocks.access.mockRejectedValue(new Error("EACCES"));
      }
      const result = gatewayArgs({ wrapperPath, runtimePath: undefined });
      if (executable) {
        await expect(result).resolves.toEqual({ programArguments: [wrapperPath, ...gatewayTail] });
      } else {
        await expect(result).rejects.toThrow("OPENCLAW_WRAPPER must point to an executable file");
      }
    },
  );
});

describe("resolveNodeProgramArguments", () => {
  it("selects the package launcher when invoked from source", async () => {
    const launcher = path.resolve("/repo/openclaw.mjs");
    mockEntrypoint(path.resolve("/repo/src/entry.ts"));
    fsMocks.access.mockImplementation(async (candidate: string) => {
      if (candidate !== launcher) {
        throw new Error("missing");
      }
    });
    expect((await nodeArgs()).programArguments).toEqual([validatedNodePath, launcher, ...nodeTail]);
  });

  it.each([true, false])("requires the built CLI launcher (available=%s)", async (available) => {
    const entry = path.resolve("/opt/openclaw/dist/entry.js");
    fsMocks.access.mockImplementation(async (candidate: string) => {
      if (candidate !== defaultEntrypoint && (!available || candidate !== entry)) {
        throw new Error("missing");
      }
    });
    if (available) {
      expect((await nodeArgs()).programArguments.slice(0, 2)).toEqual([validatedNodePath, entry]);
    } else {
      await expect(nodeArgs()).rejects.toThrow("Cannot find built CLI");
    }
  });

  it("persists plaintext restrictions and replaces them with all commands while retaining node options", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    fsMocks.stat.mockImplementation(actualFs.stat);
    vi.spyOn(windowsEncoding, "resolveWindowsOemCodePage").mockReturnValue(437);
    const home = tempDirs.make("openclaw-node-command-reset-");
    const env = {
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_STATE_DIR: path.join(home, "state"),
      OPENCLAW_TASK_SCRIPT_NAME: "node.cmd",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node Fixture",
    };
    const stdout = new PassThrough();
    const options = {
      host: "gateway.example",
      port: 18789,
      displayName: "Fixture Node",
      installedAppsSharing: false,
      tls: false,
      runtime: "node" as const,
    };
    try {
      const restricted = await nodeArgs({
        ...options,
        commands: ["fixture.list", "fixture.read"],
      });
      expect(restricted.programArguments).toEqual([
        validatedNodePath,
        path.resolve("/opt/openclaw/openclaw.mjs"),
        ...nodeTail,
        "--no-tls",
        "--display-name",
        "Fixture Node",
        "--no-share-installed-apps",
        "--commands",
        "fixture.list,fixture.read",
      ]);
      await stageScheduledTask({ env, stdout, ...restricted });
      const saved = await readScheduledTaskCommand(env);
      expect(saved?.programArguments).toEqual(
        expect.arrayContaining(["--no-tls", "--commands", "fixture.list,fixture.read"]),
      );

      const reset = await nodeArgs({ ...options, allCommands: true });
      await stageScheduledTask({ env, stdout, ...reset });
      const replaced = await readScheduledTaskCommand(env);
      expect(replaced?.programArguments).toEqual(
        expect.arrayContaining([
          "--all-commands",
          "--no-tls",
          "--display-name",
          "Fixture Node",
          "--no-share-installed-apps",
        ]),
      );
      expect(replaced?.programArguments).not.toContain("--commands");
      expect(replaced?.programArguments).not.toContain("fixture.list,fixture.read");
    } finally {
      stdout.destroy();
    }
  });
});
