import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { resolveUpdatedNodeRuntime } from "../../node-runtime-update.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type Probe = (
  file: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;
const spawn = vi.hoisted(() => vi.fn<Probe>());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawn,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const targetRuntime = {
  env: { CI: "1", OPENCLAW_NODE_UPDATE_RESPAWNED: "1" },
  acceptVersion: (version: string) => version.startsWith("26."),
  nodeVersion: "26.12.1",
};
const nodeBinary = (root: string) =>
  path.join(root, ...(process.platform === "win32" ? ["node.exe"] : ["bin", "node"]));
async function createRuntime(versioned = false) {
  const root = path.join(tempDirs.make("openclaw-node-update-"), ".openclaw");
  const alias = path.join(root, "tools", "cli-node", "tools", "node");
  const candidate = nodeBinary(versioned ? `${alias}-v24.19.0` : alias);
  await writeRuntime(candidate);
  if (versioned) {
    await fs.symlink("node-v24.19.0", alias, "dir");
  }
  return { root, candidate, alias };
}

async function writeRuntime(candidate: string) {
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  await fs.writeFile(candidate, "private runtime fixture");
}

const capabilities = { available: true, text: true, blob: true, json: true };
const probeResult = (version: string): SpawnSyncReturns<string> => ({
  pid: 100,
  status: 0,
  signal: null,
  output: [],
  stderr: "",
  stdout: JSON.stringify({
    nodeVersion: version,
    bunVersion: null,
    sqliteProbe: { ...capabilities, version: "3.53.4" },
  }),
});

it.each([
  ["healthy supported", "26.12.1", true],
  ["broken supported", "26.12.1", false],
  ["lossless vendor", "24.22.1+vendor.1", true],
] as const)("validates a %s cached runtime", async (_label, version, lossless) => {
  vi.stubEnv("CI", "1");
  vi.stubEnv("OPENCLAW_NODE_UPDATE_RESPAWNED", "");
  vi.stubEnv("NODE_OPTIONS", undefined);
  const { spawnSync } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { root, candidate } = await createRuntime();
  const preload = path.join(root, "binding.mjs");
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
  const nodeExecPath = resolveTestNodeExecPath();
  spawn.mockImplementation((_file, args, options) =>
    spawnSync(nodeExecPath, ["--import", pathToFileURL(preload).href, ...args], options),
  );

  expect(await resolveUpdatedNodeRuntime(root)).toBe(lossless ? candidate : null);
});

it.each([true, false])("provisions without a TTY (compatible=%s)", async (compatible) => {
  const { root, candidate } = await createRuntime();
  spawn
    .mockReturnValueOnce(probeResult("24.19.0"))
    .mockReturnValue(probeResult(compatible ? "26.12.1" : "24.19.0"));
  const installCommand = vi.fn(async () => 0);
  const result = await resolveUpdatedNodeRuntime(root, { ...targetRuntime, installCommand });
  expect(installCommand.mock.calls).toEqual([
    [expect.any(String), expect.arrayContaining(["26.12.1"]), targetRuntime.env],
  ]);
  expect(result).toBe(compatible ? candidate : null);
});

it.skipIf(process.platform === "win32").each(["compatible", "incompatible", "missing"] as const)(
  "rechecks the published private Node alias after %s installation",
  async (outcome) => {
    const { root, candidate: oldNode, alias } = await createRuntime(true);
    const newNode = nodeBinary(`${alias}-v26.12.1`);
    await writeRuntime(newNode);
    spawn.mockImplementation((file) =>
      probeResult(file === newNode && outcome === "compatible" ? "26.12.1" : "24.19.0"),
    );
    const installCommand = vi.fn(async () => {
      await fs.unlink(alias);
      if (outcome !== "missing") {
        await fs.symlink("node-v26.12.1", alias, "dir");
      }
      return 0;
    });
    const result = await resolveUpdatedNodeRuntime(root, { ...targetRuntime, installCommand });
    expect(installCommand).toHaveBeenCalledOnce();
    expect(result).toBe(outcome === "compatible" ? newNode : null);
    expect(spawn.mock.calls.map(([file]) => file)).toEqual(
      outcome === "missing" ? [oldNode] : [oldNode, newNode],
    );
    expect(await fs.readFile(oldNode, "utf8")).toBe("private runtime fixture");
  },
);
