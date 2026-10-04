import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { RuntimeEnv } from "../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { backupSqliteBatchCommand } from "./backup-sqlite-batch.js";

let state: OpenClawTestState;
let runtime: RuntimeEnv;

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-sqlite-batch-", layout: "state-only" });
  runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  await state.writeConfig({
    plugins: { enabled: false },
    agents: {
      ownership: "explicit",
      entries: { alice: { agentDir: state.path("alice") }, bob: { agentDir: state.path("bob") } },
    },
  });
});

afterEach(async () => {
  await state.cleanup();
});

async function createAgent(agentId: string, owner = agentId): Promise<string> {
  const databasePath = state.path(agentId, "openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new (requireNodeSqlite().DatabaseSync)(databasePath);
  try {
    database.exec(
      `${OPENCLAW_AGENT_SCHEMA_SQL}; PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`,
    );
    database
      .prepare(
        "INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at) VALUES ('primary', 'agent', ?, ?, NULL, 1, 1)",
      )
      .run(OPENCLAW_AGENT_SCHEMA_VERSION, owner);
  } finally {
    database.close();
  }
  return databasePath;
}

async function run(operations: unknown[]) {
  const request = await state.writeJson("request.json", {
    schema: "openclaw.sqlite-batch.v1",
    operations,
  });
  return backupSqliteBatchCommand(runtime, request, { json: true });
}

function createOperation(agentId: string) {
  return {
    id: agentId,
    operation: "create",
    agentId,
    repository: state.path(`snapshots-${agentId}`),
  };
}

async function snapshotAlice(): Promise<string> {
  await createAgent("alice");
  const created = await run([createOperation("alice")]);
  const outcome = created.outcomes[0];
  if (!outcome || outcome.status !== "completed" || outcome.operation !== "create") {
    throw new Error("snapshot fixture failed");
  }
  return outcome.result.snapshotPath;
}

describe("SQLite batch commands", () => {
  it("creates, restores, and preflights multiple owned stores with one result per invocation", async () => {
    await createAgent("alice");
    await createAgent("bob");
    const created = await run([createOperation("alice"), createOperation("bob")]);
    expect(created.ok).toBe(true);
    expect(runtime.log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]))).toEqual(created);
    expect(runtime.exit).not.toHaveBeenCalled();
    const restores = created.outcomes.map((outcome) => {
      if (outcome.status !== "completed" || outcome.operation !== "create") {
        throw new Error("create failed");
      }
      expect(outcome.result.manifest.database).toMatchObject({
        role: "agent",
        agentId: outcome.id,
      });
      return {
        id: outcome.id,
        operation: "restore",
        agentId: outcome.id,
        snapshot: outcome.result.snapshotPath,
        target: state.path("restored", `${outcome.id}.sqlite`),
      };
    });
    const restored = await run(restores);
    expect(restored.ok).toBe(true);
    const preflight = await run(
      restores.map((operation) => ({
        id: operation.id,
        operation: "preflight",
        agentId: operation.agentId,
        path: operation.target,
      })),
    );
    expect(preflight.ok).toBe(true);
    expect(
      preflight.outcomes.map((outcome) =>
        outcome.status === "completed" && outcome.operation === "preflight"
          ? outcome.result.status
          : null,
      ),
    ).toEqual(["exact", "exact"]);
    expect(runtime.log).toHaveBeenCalledTimes(3);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it.each(["owner", "hash", "existing-target", "sidecar"])(
    "refuses %s violations and skips all later restores",
    async (violation) => {
      const snapshot = await snapshotAlice();
      const target = state.path("restore.sqlite");
      if (violation === "hash") {
        await fs.appendFile(path.join(snapshot, "database.sqlite"), "changed");
      }
      if (violation === "existing-target") {
        await fs.writeFile(target, "existing-data");
      }
      if (violation === "sidecar") {
        await fs.writeFile(`${target}-wal`, "live-wal");
      }
      const response = await run([
        {
          id: "first",
          operation: "restore",
          agentId: violation === "owner" ? "bob" : "alice",
          snapshot,
          target,
        },
        {
          id: "later",
          operation: "restore",
          agentId: "alice",
          snapshot,
          target: state.path("later.sqlite"),
        },
      ]);
      expect(response.ok).toBe(false);
      expect(response.outcomes).toMatchObject([
        {
          id: "first",
          status: "failed",
          error: { code: "restore-failed", message: expect.any(String) },
        },
        { id: "later", status: "skipped", error: { code: "prior-operation-failed" } },
      ]);
      expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
      await expect(fs.access(state.path("later.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
      if (violation === "existing-target") {
        await expect(fs.readFile(target, "utf8")).resolves.toBe("existing-data");
      } else {
        await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("rejects a configured source whose database has a different owner", async () => {
    await createAgent("alice", "bob");
    const response = await run([createOperation("alice"), createOperation("bob")]);
    expect(response.outcomes).toMatchObject([
      { status: "failed", error: { code: "create-failed" } },
      { status: "skipped" },
    ]);
    await expect(fs.readdir(state.path("snapshots-alice"))).resolves.toEqual([]);
  });

  it("returns exact native preflight refusal details without creating or migrating stores", async () => {
    const databasePath = await createAgent("alice");
    const before = await fs.readFile(databasePath);
    const response = await run([
      { id: "alice", operation: "preflight", agentId: "bob", path: databasePath },
    ]);
    expect(response.outcomes[0]).toMatchObject({
      status: "failed",
      error: { code: "preflight-refused" },
      result: {
        schema: "openclaw.agent-schema-preflight.v1",
        status: "incompatible",
        agentId: "bob",
      },
    });
    await expect(fs.readFile(databasePath)).resolves.toEqual(before);
  });

  it.each(["duplicate-id", "noncanonical-agent", "unknown-field"])(
    "validates the complete %s request before creating a snapshot",
    async (violation) => {
      await createAgent("alice");
      const first = createOperation("alice");
      const second =
        violation === "duplicate-id"
          ? createOperation("alice")
          : {
              ...createOperation("bob"),
              ...(violation === "noncanonical-agent" ? { agentId: "BOB" } : { unknown: true }),
            };
      await expect(run([first, second])).rejects.toThrow();
      await expect(fs.access(first.repository)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
