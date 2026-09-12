import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { resolveUpdatedNodeRuntime } from "../../node-runtime-update.mjs";
import { withTempDir } from "../test-utils/temp-dir.js";

const mocks = vi.hoisted(() => ({
  spawn:
    vi.fn<
      (
        file: string,
        args: string[],
        options: SpawnSyncOptionsWithStringEncoding,
      ) => SpawnSyncReturns<string>
    >(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: mocks.spawn,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each([
  ["healthy supported", "26.8.1", true],
  ["broken supported", "26.8.1", false],
  ["lossless vendor", "24.15.0+vendor.1", true],
] as const)("validates a %s cached runtime", async (_label, version, lossless) => {
  vi.stubEnv("CI", "1");
  vi.stubEnv("OPENCLAW_NODE_UPDATE_RESPAWNED", "");
  vi.stubEnv("NODE_OPTIONS", undefined);
  const childProcess =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  await withTempDir("openclaw-node-recovery-", async (directory) => {
    const home = await fs.realpath(directory);
    const nodeRoot = path.join(home, ".openclaw", "tools", "cli-node", "tools", "node");
    const candidate =
      process.platform === "win32"
        ? path.join(nodeRoot, "node.exe")
        : path.join(nodeRoot, "bin", "node");
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    await fs.writeFile(candidate, "synthetic runtime; the probe uses the current Node");
    const preload = path.join(home, "binding.mjs");
    await fs.writeFile(
      preload,
      `
      import { DatabaseSync } from "node:sqlite";
      Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });
      if (!${lossless}) {
        const prepare = DatabaseSync.prototype.prepare;
        DatabaseSync.prototype.prepare = function(sql) {
          const statement = prepare.call(this, sql);
          const get = statement.get;
          statement.get = function(...args) {
            const row = get.apply(this, args);
            if (row) for (const key of Object.keys(row)) {
              if (typeof row[key] === "string") row[key] = row[key].split("\\0")[0];
            }
            return row;
          };
          return statement;
        };
      }
    `,
    );
    mocks.spawn.mockImplementation((_file, args, options) =>
      childProcess.spawnSync(
        process.execPath,
        ["--import", pathToFileURL(preload).href, ...args],
        options,
      ),
    );

    expect(await resolveUpdatedNodeRuntime(path.join(home, ".openclaw"))).toBe(
      lossless ? candidate : null,
    );
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.spawn.mock.calls[0]?.[2].timeout).toBe(5_000);
    const result = mocks.spawn.mock.results[0];
    if (result?.type !== "return") {
      throw new Error("Runtime probe did not return");
    }
    expect(JSON.parse(result.value.stdout)).toMatchObject({
      version,
      probe: { available: true, text: lossless, blob: true, json: true },
    });
  });
});

it.each([true, false])(
  "provisions a target-compatible private runtime without a TTY (compatible=%s)",
  async (compatible) => {
    await withTempDir("openclaw-node-target-", async (directory) => {
      const root = path.join(await fs.realpath(directory), ".openclaw");
      const candidate = path.join(
        root,
        "tools",
        "cli-node",
        "tools",
        "node",
        ...(process.platform === "win32" ? ["node.exe"] : ["bin", "node"]),
      );
      await fs.mkdir(path.dirname(candidate), { recursive: true });
      await fs.writeFile(candidate, "existing private Node");
      let installed = false;
      mocks.spawn.mockImplementation(() => ({
        pid: 100,
        status: 0,
        signal: null,
        output: [],
        stderr: "",
        stdout: JSON.stringify({
          version: installed && compatible ? "26.8.1" : "24.19.0",
          probe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
        }),
      }));
      const env = { CI: "1", OPENCLAW_NODE_UPDATE_RESPAWNED: "1" };
      const installCommand = vi.fn(
        async (_command: string, args: string[], installEnv: NodeJS.ProcessEnv) => {
          expect(args).toContain("26.8.1");
          expect(installEnv).toEqual(env);
          installed = true;
          return 0;
        },
      );
      const result = await resolveUpdatedNodeRuntime(root, {
        env,
        acceptVersion: (version) => version.startsWith("26."),
        nodeVersion: "26.8.1",
        installCommand,
      });
      expect(installCommand).toHaveBeenCalledOnce();
      expect(result).toBe(compatible ? candidate : null);
    });
  },
);

it.skipIf(process.platform === "win32").each(["compatible", "incompatible", "missing"] as const)(
  "rechecks the published private Node alias after %s installation",
  async (outcome) => {
    await withTempDir("openclaw-private-node-alias-", async (directory) => {
      const root = path.join(await fs.realpath(directory), ".openclaw");
      const tools = path.join(root, "tools", "cli-node", "tools");
      const oldRoot = path.join(tools, "node-v24.19.0");
      const newRoot = path.join(tools, "node-v26.8.1");
      const oldNode = path.join(oldRoot, "bin", "node");
      const newNode = path.join(newRoot, "bin", "node");
      const alias = path.join(tools, "node");
      for (const node of [oldNode, newNode]) {
        await fs.mkdir(path.dirname(node), { recursive: true });
        await fs.writeFile(node, "private runtime fixture");
      }
      await fs.symlink(path.basename(oldRoot), alias, "dir");
      mocks.spawn.mockImplementation((file) => ({
        pid: 100,
        status: 0,
        signal: null,
        output: [],
        stderr: "",
        stdout: JSON.stringify({
          version: file === newNode && outcome === "compatible" ? "26.8.1" : "24.19.0",
          probe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
        }),
      }));
      const installCommand = vi.fn(async () => {
        await fs.unlink(alias);
        if (outcome !== "missing") {
          await fs.symlink(path.basename(newRoot), alias, "dir");
        }
        return 0;
      });
      const result = await resolveUpdatedNodeRuntime(root, {
        env: { CI: "1", OPENCLAW_NODE_UPDATE_RESPAWNED: "1" },
        acceptVersion: (version) => version.startsWith("26."),
        nodeVersion: "26.8.1",
        installCommand,
      });
      expect(installCommand).toHaveBeenCalledOnce();
      expect(result).toBe(outcome === "compatible" ? newNode : null);
      expect(mocks.spawn.mock.calls.map(([file]) => file)).toEqual(
        outcome === "missing" ? [oldNode] : [oldNode, newNode],
      );
      expect(await fs.readFile(oldNode, "utf8")).toBe("private runtime fixture");
    });
  },
);
