import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withDaemonRuntimePinStore } from "../daemon/runtime-pin-store.js";
import { runCommandBuffered } from "../process/exec.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { CLIENT_CREDENTIAL_SCHEMA_SQL } from "./client-credential-schema.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { UpdateCandidateStateSnapshotSchema } from "./update-candidate-state.js";
import { inventoryUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const credential = {
  socket_key: "current",
  socket_path: "/synthetic/native.sock",
  socket_token: "synthetic-socket-token",
  updated_at_ms: 456,
};

async function runWorker(input: Record<string, unknown>): Promise<unknown> {
  const result = await runCommandBuffered(
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
      ),
    ],
    { input: JSON.stringify(input), timeoutMs: 30_000, killGraceMs: 500 },
  );
  expect(result.code, result.stderr.toString("utf8")).toBe(0);
  return JSON.parse(result.stdout.toString("utf8"));
}

it.each(["legacy", "daemon-aware", "local-aware", "legacy-alias", "local-aware-alias"] as const)(
  "%s worker replies preserve local capture independently of schema visibility",
  async (caller) => {
    const root = await fs.realpath(dirs.make("update-local-schemas-"));
    const stateDir = path.join(root, "source");
    if (caller.endsWith("-alias")) {
      const physical = path.join(root, "physical");
      await fs.mkdir(physical);
      await fs.symlink(physical, stateDir, "junction");
    }
    const targetStateDir = path.join(root, "snapshot");
    const shared = path.join(stateDir, "state", "openclaw.sqlite");
    const agent = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    const local = path.join(stateDir, "control", "services.sqlite");
    const client = path.join(stateDir, "client", "credentials.sqlite");
    // Plugin stores keep their own schema; released verifiers read them as agents.
    const workboard = path.join(stateDir, "plugins", "workboard", "workboard.sqlite");
    for (const [file, version] of [
      [shared, 7],
      [agent, 3],
      [workboard, 0],
    ] as const) {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      using db = openNodeSqliteDatabase(file);
      db.exec(`PRAGMA user_version = ${version}; CREATE TABLE evidence(value TEXT);`);
    }
    // Plugin discovery reports the physical path behind an aliased state root.
    const discoveredWorkboard = caller.endsWith("-alias")
      ? path.join(root, "physical", path.relative(stateDir, workboard))
      : workboard;
    const env = { OPENCLAW_STATE_DIR: stateDir };
    await fs.mkdir(path.dirname(client), { recursive: true, mode: 0o700 });
    {
      using db = openNodeSqliteDatabase(client);
      db.exec(CLIENT_CREDENTIAL_SCHEMA_SQL);
      db.exec("PRAGMA user_version = 1");
      db.prepare("INSERT INTO native_exec_socket_credentials VALUES (?, ?, ?, ?)").run(
        ...Object.values(credential),
      );
    }
    const intent = {
      state_key: "daemon-runtime-pin:raw",
      value_json: "{ malformed",
      updated_at_ms: 123,
    };
    withDaemonRuntimePinStore(env, true, (db) => {
      db.prepare("INSERT INTO daemon_runtime_pins VALUES (?, ?, ?)").run(...Object.values(intent));
    });
    const localAware = caller.startsWith("local-aware");
    const daemonAware = !caller.startsWith("legacy");
    const input = {
      stateDir,
      targetStateDir,
      candidateRoot: root,
      config: {},
      env,
      ...(daemonAware ? { includeLocalStoreVersions: true } : {}),
      ...(localAware ? { includeClientCredentialStoreVersion: true } : {}),
    };
    const capture = caller !== "local-aware" && caller !== "legacy-alias";
    const admitted = capture ? await inventoryUpdateCandidateStateWorker(input) : undefined;
    const response = await runWorker({
      ...input,
      ...admitted,
      mode: capture ? "snapshot" : "versions",
    });
    const versions = capture
      ? UpdateCandidateStateSnapshotSchema.parse(response).versions
      : UpdateCandidateStateSnapshotSchema.shape.versions.parse(response);
    const expected = [
      { path: agent, userVersion: 3 },
      ...(localAware ? [{ path: client, userVersion: 1 }] : []),
      ...(daemonAware ? [{ path: local, userVersion: 1 }] : []),
      { path: shared, userVersion: 7, contentVersion: 7 },
      ...(daemonAware ? [{ path: discoveredWorkboard, userVersion: 0 }] : []),
    ];
    expect(versions).toEqual(expected);
    if (!capture) {
      return;
    }
    expect(admitted?.databaseInventory).toContain(discoveredWorkboard);
    const openCopy = (file: string) =>
      openNodeSqliteDatabase(path.join(targetStateDir, path.relative(stateDir, file)), {
        readOnly: true,
      });
    using copied = openCopy(local);
    expect(copied.prepare("SELECT * FROM daemon_runtime_pins").all()).toEqual([intent]);
    if (discoveredWorkboard === workboard) {
      using copiedWorkboard = openCopy(workboard);
      expect(copiedWorkboard.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    }
    using copiedClient = openCopy(client);
    expect(copiedClient.prepare("SELECT * FROM native_exec_socket_credentials").all()).toEqual([
      credential,
    ]);
  },
);

it("legacy replies still expose wrong-schema agents to the released 2026.11.3 verifier", async () => {
  const root = await fs.realpath(dirs.make("update-legacy-agent-schemas-"));
  const stateDir = path.join(root, "source");
  const shared = path.join(stateDir, "state", "openclaw.sqlite");
  const main = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  const override = path.join(root, "override-agent", "openclaw-agent.sqlite");
  const registered = path.join(root, "registered", "openclaw-agent.sqlite");
  const workboard = path.join(stateDir, "plugins", "workboard", "workboard.sqlite");
  for (const [file, version] of [
    [shared, 7],
    [main, 3],
    [override, 3],
    [registered, 3],
    [workboard, 0],
  ] as const) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    using db = openNodeSqliteDatabase(file);
    db.exec(`PRAGMA user_version = ${version}; CREATE TABLE evidence(value TEXT);`);
    if (file === shared) {
      db.exec("CREATE TABLE agent_databases (path TEXT)");
      db.prepare("INSERT INTO agent_databases VALUES (?)").run(registered);
    }
  }
  const input = {
    stateDir,
    config: {},
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: path.dirname(override) },
    mode: "versions",
  };
  const parse = (response: unknown) =>
    UpdateCandidateStateSnapshotSchema.shape.versions.parse(response);
  const legacy = parse(await runWorker(input));
  // The released verifier treats every non-shared, present row as an agent database
  // (src/cli/update-cli/update-command-migrated.ts at 847611dcaa3b).
  const flagged = legacy
    .filter((entry) => entry.path !== shared && entry.userVersion !== null)
    .filter((entry) => entry.userVersion !== OPENCLAW_AGENT_SCHEMA_VERSION)
    .map((entry) => entry.path);
  expect(flagged.toSorted()).toEqual([main, override, registered].toSorted());
  const modern = parse(await runWorker({ ...input, includeLocalStoreVersions: true }));
  expect(modern).toContainEqual({ path: workboard, userVersion: 0 });
});
