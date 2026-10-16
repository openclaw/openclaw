import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimePaths from "../daemon/runtime-paths.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { prepareGitCandidateNodeRuntime } from "../infra/update-runner-git-node-preflight.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { snapshotPreflightSourceManifest } from "../state/openclaw-database-preflight.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { assertNodeRuntimeUpdateCompatible } from "./auto-update-compatibility.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  nodeRuntime: vi.fn<typeof prepareGitCandidateNodeRuntime>(async () => ({ env: {} })),
}));

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: mocks.command,
}));
vi.mock("../infra/update-runner-git-node-preflight.js", () => ({
  prepareGitCandidateNodeRuntime: mocks.nodeRuntime,
}));
vi.mock("../state/openclaw-database-preflight.js", () => ({
  preflightOpenClawDatabaseSchemas: async () => ({ incompatible: [], indeterminate: [] }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.nodeRuntime.mockResolvedValue({ env: {} });
});

async function createCompatibilityFixture(directory: string) {
  const stateDir = path.join(directory, "node-state");
  const packageRoot = path.join(directory, "candidate");
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.18",
        openclaw: {
          schemaVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
        },
      }),
    ),
    ...[
      "openclaw.mjs",
      "node-host-launcher.mjs",
      "dist/node-host-launcher-bootstrap.js",
      "dist/entry.js",
    ].map((relativePath) => fs.writeFile(path.join(packageRoot, relativePath), "export {};\n")),
  ]);
  const statePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(statePath);
  try {
    database.exec("CREATE TABLE agent_databases (agent_id TEXT, path TEXT);");
    database
      .prepare("INSERT INTO agent_databases VALUES (?, ?)")
      .run("removed", "removed-agent.sqlite");
  } finally {
    database.close();
  }
  return { stateDir, packageRoot, statePath };
}

describe("candidate node runtime compatibility", () => {
  it.each([
    { runtime: "renamed Node", accepted: true },
    { runtime: "Node", accepted: false },
    { runtime: "Bun", accepted: true },
  ])("checks the candidate against its $runtime host", async ({ runtime, accepted }) => {
    const originalExecPath = process.execPath;
    const originalVersions = process.versions;
    const system =
      runtime === "renamed Node"
        ? vi.spyOn(runtimePaths, "resolveSystemNodeInfo").mockResolvedValue(null)
        : undefined;
    Object.defineProperty(process, "versions", {
      value: {
        ...originalVersions,
        node: runtime === "renamed Node" ? "26.7.0" : originalVersions.node,
        bun: runtime === "Bun" ? "1.4.3" : undefined,
      },
    });
    try {
      if (runtime === "renamed Node") {
        const { prepareGitCandidateNodeRuntime: prepareRuntime } = await vi.importActual<
          typeof import("../infra/update-runner-git-node-preflight.js")
        >("../infra/update-runner-git-node-preflight.js");
        mocks.nodeRuntime.mockImplementation(prepareRuntime);
        vi.stubEnv("PATH", "");
        Object.defineProperty(process, "execPath", { value: path.resolve("fixture", "node26") });
      } else {
        mocks.nodeRuntime.mockResolvedValue({
          step: {
            name: "preflight-node-runtime",
            command: "check Node",
            cwd: "/fixture",
            durationMs: 0,
            exitCode: 1,
            stderrTail: "No system Node was found.",
          },
        });
      }
      await withTestDir({ prefix: "openclaw-node-compat-runtime-" }, async (directory) => {
        const fixture = await createCompatibilityFixture(directory);
        await fs.rm(fixture.statePath);
        const compatible = assertNodeRuntimeUpdateCompatible(fixture);
        await (accepted
          ? expect(compatible).resolves.toBeUndefined()
          : expect(compatible).rejects.toThrow("No system Node was found."));
        if (runtime === "renamed Node") {
          expect(system).not.toHaveBeenCalled();
        }
      });
    } finally {
      Object.defineProperty(process, "execPath", { value: originalExecPath });
      Object.defineProperty(process, "versions", { value: originalVersions });
      vi.unstubAllEnvs();
      system?.mockRestore();
    }
  });
});

describe("candidate node database compatibility", () => {
  it("consolidates committed state and agent WAL rows without changing their live families", async () => {
    await withTestDir({ prefix: "openclaw-node-wal-compat-" }, async (directory) => {
      const fixture = await createCompatibilityFixture(directory);
      const { DatabaseSync } = requireNodeSqlite();
      const state = new DatabaseSync(fixture.statePath);
      const agentPath = path.join(fixture.stateDir, "agent.sqlite");
      const agent = new DatabaseSync(agentPath);
      try {
        for (const writer of [state, agent]) {
          writer.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA wal_autocheckpoint = 0;
            CREATE TABLE wal_probe (value TEXT);
            INSERT INTO wal_probe VALUES ('discard'), ('committed-wal');
            DELETE FROM wal_probe WHERE rowid = 1;
          `);
        }
        state.prepare("INSERT INTO agent_databases VALUES (?, ?)").run("active", agentPath);
        const before = snapshotPreflightSourceManifest(fixture.stateDir);
        const stateEntries = await fs.readdir(path.dirname(fixture.statePath));
        const copiedPaths: string[] = [];
        mocks.command.mockImplementation(async (argv: string[]) => {
          const entryIndex = argv.indexOf(path.join(fixture.packageRoot, "openclaw.mjs"));
          expect(argv.slice(0, entryIndex)).toEqual([
            process.execPath,
            ...(process.versions.bun ? ["--no-install"] : []),
          ]);
          expect(argv.slice(entryIndex + 1, entryIndex + 3)).toEqual([
            "database",
            copiedPaths.length === 0 ? "preflight" : "preflight-agent",
          ]);
          const commandIndex = argv.indexOf("database");
          const copiedPath = argv[commandIndex + 2] ?? "";
          expect(commandIndex).toBe(entryIndex + 1);
          expect(copiedPath).not.toBe(fixture.statePath);
          expect(copiedPath).not.toBe(agentPath);
          copiedPaths.push(copiedPath);
          for (const suffix of ["-wal", "-shm", "-journal"]) {
            await expect(fs.access(`${copiedPath}${suffix}`)).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
          const snapshot = new DatabaseSync(copiedPath, { readOnly: true });
          try {
            if (argv[commandIndex + 1] === "preflight") {
              expect(
                snapshot.prepare("SELECT rowid, agent_id, path FROM agent_databases").all(),
              ).toEqual([
                { rowid: 1, agent_id: "removed", path: "removed-agent.sqlite" },
                { rowid: 2, agent_id: "active", path: agentPath },
              ]);
            }
            expect(snapshot.prepare("PRAGMA journal_mode").get()).toEqual({
              journal_mode: "delete",
            });
            expect(snapshot.prepare("SELECT rowid, value FROM wal_probe").all()).toEqual([
              { rowid: 2, value: "committed-wal" },
            ]);
          } finally {
            snapshot.close();
          }
          return {
            code: 0,
            stdout: JSON.stringify({
              schema:
                argv[commandIndex + 1] === "preflight"
                  ? "openclaw.state-schema-preflight.v1"
                  : "openclaw.agent-schema-preflight.v1",
              status: "exact",
            }),
            stderr: "",
          };
        });

        await assertNodeRuntimeUpdateCompatible(fixture);

        expect(mocks.command).toHaveBeenCalledTimes(2);
        expect(snapshotPreflightSourceManifest(fixture.stateDir)).toEqual(before);
        expect(await fs.readdir(path.dirname(fixture.statePath))).toEqual(stateEntries);
        for (const copiedPath of copiedPaths) {
          await expect(fs.access(copiedPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        agent.close();
        state.close();
      }
    });
  });

  it.each([
    { status: "incompatible", code: 1, reason: "unexpected column" },
    { status: "startup-repairable", code: 0, reason: "required startup repair" },
  ])(
    "defers $status without changing source state or retaining its private copy",
    async ({ status, code, reason }) => {
      await withTestDir({ prefix: "openclaw-node-incompatible-" }, async (directory) => {
        const fixture = await createCompatibilityFixture(directory);
        const before = await fs.readFile(fixture.statePath);
        let copiedPath = "";
        mocks.command.mockImplementation(async (argv: string[]) => {
          copiedPath = argv[argv.indexOf("database") + 2] ?? "";
          return {
            code,
            stdout: JSON.stringify({
              schema: "openclaw.state-schema-preflight.v1",
              status,
              reason,
            }),
            stderr: "",
          };
        });
        await expect(assertNodeRuntimeUpdateCompatible(fixture)).rejects.toThrow(reason);
        expect(await fs.readFile(fixture.statePath)).toEqual(before);
        await expect(fs.access(copiedPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );
});
