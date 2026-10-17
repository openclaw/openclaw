import "../test-utils/prepare-compiled-subprocesses.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatDatabaseStoreDiagnostic } from "../infra/database-engine/diagnostics-format.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  createDiagnosticStores,
  admittedStatusOutput,
  diagnosticConfig,
  diagnosticPaths,
  matrixRoot,
  retainedAgentRoot,
  normalizeDiagnosticOutput,
} from "./doctor-database-diagnostics.test-support.js";
import { inspectDoctorDatabaseEngines } from "./doctor-database-engine-inspection.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe("Doctor per-store output", () => {
  it("reports every SQLite store and retained Matrix root without changing their files", async () => {
    const root = tempDirs.make("doctor-store-output-");
    const descriptors = await createDiagnosticStores(root);
    const files = [...Object.values(diagnosticPaths), matrixRoot, retainedAgentRoot].map((file) =>
      path.join(root, file),
    );
    const before = files.map((file) => fs.readFileSync(file));
    const inspection = await inspectDoctorDatabaseEngines({
      config: diagnosticConfig(),
      stateDir: root,
      env: { OPENCLAW_STATE_DIR: root, HOME: path.join(root, "home") },
    });
    const stores = inspection.stores!;
    expect(stores.map((store) => store.family)).toEqual([
      "state",
      "state",
      "state",
      "agent",
      "agent",
      "workboard",
      "logbook",
      "team-reports",
      "quarantine",
      "managed-update",
      "package-activation",
      "credentials",
    ]);
    const present = stores.filter((row) => row.path && files.includes(row.path));
    expect(present).toHaveLength(files.length);
    for (const store of present) {
      expect(store).toMatchObject({ observed: "sqlite", mismatch: false, connectivity: "local" });
      expect(store.schema.pending).toBe(0);
      expect(store.issues).toEqual([]);
    }
    expect(
      normalizeDiagnosticOutput(
        {
          text: stores.map(formatDatabaseStoreDiagnostic),
          json: stores,
          status: await admittedStatusOutput(root, diagnosticConfig(), descriptors),
        },
        root,
      ),
    ).toMatchSnapshot();
    expect(files.map((file) => fs.readFileSync(file))).toEqual(before);
  });

  it("shows the port remedy for unported SQLite and the legacy migration gate independently", async () => {
    const root = tempDirs.make("doctor-store-legacy-");
    const descriptors = await createDiagnosticStores(root);
    const file = path.join(root, matrixRoot);
    {
      using db = openNodeSqliteDatabase(file);
      const key = `retained:${createHash("sha256").update("retained\0!legacy:example.org\0$legacy-event").digest("hex")}`;
      db.prepare(
        "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at) VALUES ('matrix', 'inbound-dedupe', ?, ?, 1)",
      ).run(
        key,
        JSON.stringify({ roomId: "!legacy:example.org", eventId: "$legacy-event", ts: 1 }),
      );
    }
    const config = diagnosticConfig();
    config.database = { engine: "postgres" };
    const inspection = await inspectDoctorDatabaseEngines({
      config,
      stateDir: root,
      env: { OPENCLAW_STATE_DIR: root, HOME: path.join(root, "home") },
    });
    const matrix = inspection.stores!.find((store) => store.path === file)!;
    expect(matrix).toMatchObject({
      observed: "sqlite",
      mismatch: true,
      legacyMigrations: { state: "pending" },
    });
    expect(matrix.nextSteps.join(" ")).toContain("database port");
    expect(matrix.nextSteps.join(" ")).toContain("doctor --fix");
    expect(
      normalizeDiagnosticOutput(
        {
          text: formatDatabaseStoreDiagnostic(matrix),
          json: matrix,
          status: await admittedStatusOutput(root, config, descriptors),
        },
        root,
      ),
    ).toMatchSnapshot();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "retains unreadable store paths and directories as unknown rather than absent",
    async () => {
      const root = tempDirs.make("doctor-store-permissions-");
      await createDiagnosticStores(root);
      const stateFile = path.join(root, diagnosticPaths.state);
      const matrixDirectory = path.join(root, "matrix/accounts/retained");
      const deniedDirectories = [path.dirname(stateFile), matrixDirectory];
      try {
        for (const directory of deniedDirectories) {
          fs.chmodSync(directory, 0);
        }
        const inspection = await inspectDoctorDatabaseEngines({
          config: diagnosticConfig(),
          stateDir: root,
          env: { OPENCLAW_STATE_DIR: root, HOME: path.join(root, "home") },
        });
        for (const deniedPath of [stateFile, matrixDirectory]) {
          const store = inspection.stores!.find((entry) => entry.path === deniedPath);
          expect(store).toMatchObject({
            family: "state",
            observed: "unknown",
            connectivity: "unknown",
            schema: { version: null, pending: null },
            issues: ["The physical store root could not be read; its contents are unknown."],
          });
          expect(store!.nextSteps.join(" ")).toContain("permissions");
          expect(store!.nextSteps.join(" ")).not.toContain("Store is not present");
        }
      } finally {
        for (const directory of deniedDirectories) {
          fs.chmodSync(directory, 0o700);
        }
      }
    },
  );

  it("keeps a missing configured agent store alongside existing stores", async () => {
    const root = tempDirs.make("doctor-store-missing-agent-");
    await createDiagnosticStores(root);
    const agentDir = path.join(root, "agents/missing/agent");
    const inspection = await inspectDoctorDatabaseEngines({
      config: {
        ...diagnosticConfig(),
        agents: { entries: { main: {}, missing: { agentDir } } },
      },
      stateDir: root,
      env: { OPENCLAW_STATE_DIR: root, HOME: path.join(root, "home") },
    });
    expect(
      inspection.stores!.find((store) => store.path === path.join(root, diagnosticPaths.agent)),
    ).toMatchObject({ family: "agent", observed: "sqlite" });
    const missing = inspection.stores!.find(
      (store) => store.path === path.join(agentDir, "openclaw-agent.sqlite"),
    );
    expect(missing).toMatchObject({
      family: "agent",
      observed: "unknown",
      connectivity: "unknown",
      schema: { version: null, pending: null },
    });
    expect(missing!.nextSteps.join(" ")).toContain("Initialize it through its owning feature");
  });
});
