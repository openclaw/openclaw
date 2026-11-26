import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { RecoveryCleanupReport } from "../commands/doctor-session-sqlite-recovery-inventory.js";
import { useDoctorSessionSqliteTestFixture } from "../commands/doctor-session-sqlite.test-support.js";
import { captureGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { readSessionSqliteMigrationManifest } from "../infra/session-sqlite-migration-manifest.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resetGatewayTestState } from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { createAuthorityGatewayTestEnv } from "./test-helpers.env.js";

const observation = vi.hoisted(() => ({ beforeAdmission: () => {} }));
const { createVerifiedRecoveryStore } = useDoctorSessionSqliteTestFixture();

vi.mock("../infra/gateway-lock.js", async (original) => {
  const actual = await original<typeof import("../infra/gateway-lock.js")>();
  return {
    ...actual,
    acquireGatewayLock: (options: Parameters<typeof actual.acquireGatewayLock>[0]) =>
      actual.acquireGatewayLock({ ...options, allowInTests: true }),
  };
});

// Observe a real retirement claim before changing its destination. The production
// Gateway owner and worker still grant or refuse each following effect.
vi.mock("../infra/sqlite-worker-operation-admission.js", async (original) => {
  const actual = await original<typeof import("../infra/sqlite-worker-operation-admission.js")>();
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (
      ...[admit, attachment, refresh]: Parameters<
        typeof actual.createSqliteWorkerOperationAdmission
      >
    ) =>
      actual.createSqliteWorkerOperationAdmission(
        (request, grant) => {
          observation.beforeAdmission();
          admit(request, grant);
        },
        attachment,
        refresh,
      ),
  };
});

afterEach(() => {
  observation.beforeAdmission = () => {};
  vi.restoreAllMocks();
  resetGatewayTestState();
});

it.each(["write", "replace"] as const)(
  "manual cleanup distinguishes owned writes from destination replacement: %s",
  { timeout: 90_000 },
  async (change) => {
    const fixture = await createVerifiedRecoveryStore();
    const originals = new Map(
      fixture.target.completedMoves
        .filter((move) => move.artifact?.classification !== "protected")
        .map((move) => [move.archivePath, fs.readFileSync(move.archivePath)]),
    );
    const protectedOriginals = new Map(
      fixture.target.completedMoves
        .filter((move) => move.artifact?.classification === "protected")
        .map((move) => [move.archivePath, fs.readFileSync(move.archivePath)]),
    );
    expect(originals.size).toBe(2);
    const trajectory = fixture.target.completedMoves.find((move) => move.kind === "trajectory");
    expect(trajectory?.artifact?.classification).toBe("protected");
    await closeOpenClawStateDatabaseAsync();
    await withEnvAsync(
      {
        ...createAuthorityGatewayTestEnv(),
        HOME: fixture.store.tempDir,
        OPENCLAW_HOME: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_AGENT_DIR: undefined,
        OPENCLAW_STATE_DIR: fixture.store.stateDir,
        OPENCLAW_CONFIG_PATH: fixture.store.configPath,
      },
      async () => {
        const { client, server } = await startGatewayWithClient({
          configPath: fixture.store.configPath,
          token: "synthetic-cleanup-token",
          scopes: ["operator.admin"],
          cfg: {
            gateway: { mode: "local", auth: { mode: "token", token: "synthetic-cleanup-token" } },
            agents: {
              entries: { main: {} },
              defaults: {
                workspace: path.join(fixture.store.tempDir, "workspace"),
                skipBootstrap: true,
              },
            },
            plugins: { enabled: false, slots: { memory: "none" } },
            models: { catalogRefresh: { enabled: false } },
            cron: { enabled: false },
            update: { checkOnStart: false },
          },
        });
        let changed = false;
        try {
          await server.startupSettled;
          const owner = captureGatewayStateOwner(resolveOpenClawStateSqlitePath());
          expect(owner?.ownerId).toBeTruthy();
          const configBefore = fs.readFileSync(fixture.store.configPath);
          observation.beforeAdmission = () => {
            const claimed = readSessionSqliteMigrationManifest(
              fixture.manifestPath,
            )!.targets[0]!.completedMoves.some(
              (move) =>
                move.artifact?.disposal.state === "pending-disposal" &&
                fs.existsSync(move.artifact.disposal.claimPath),
            );
            if (changed || !claimed) {
              return;
            }
            if (change === "write") {
              // A physical write between checks; this does not exercise a Gateway writer API.
              using database = new DatabaseSync(fixture.target.sqlitePath);
              database.exec(
                "CREATE TABLE live_cleanup_write(value TEXT); INSERT INTO live_cleanup_write VALUES ('current owner')",
              );
            } else {
              const replacement = `${fixture.target.sqlitePath}.replacement`;
              fs.copyFileSync(fixture.target.sqlitePath, replacement);
              fs.renameSync(replacement, fixture.target.sqlitePath);
            }
            changed = true;
          };
          const result = await client.request<RecoveryCleanupReport>("update.recovery.cleanup", {
            dryRun: false,
            expectedOwnerId: owner!.ownerId,
          });
          expect(changed).toBe(true);
          if (change === "write") {
            expect(result.status).toBe("complete");
            for (const file of originals.keys()) {
              expect(fs.existsSync(file), file).toBe(false);
            }
            using database = new DatabaseSync(fixture.target.sqlitePath, { readOnly: true });
            expect(database.prepare("SELECT value FROM live_cleanup_write").get()).toEqual({
              value: "current owner",
            });
          } else {
            expect(result.status).toBe("blocked");
            for (const [file, bytes] of originals) {
              const move = readSessionSqliteMigrationManifest(
                fixture.manifestPath,
              )!.targets[0]!.completedMoves.find((item) => item.archivePath === file)!;
              const disposal = move.artifact!.disposal;
              const retained = fs.existsSync(file)
                ? file
                : disposal.state === "pending-disposal"
                  ? disposal.claimPath
                  : file;
              expect(fs.readFileSync(retained)).toEqual(bytes);
            }
          }
          for (const [file, bytes] of protectedOriginals) {
            expect(fs.readFileSync(file)).toEqual(bytes);
          }
          expect(fs.readFileSync(fixture.store.configPath)).toEqual(configBefore);
          owner!.assertCurrent();
        } finally {
          observation.beforeAdmission = () => {};
          await disconnectGatewayClient(client);
          await server.close({ reason: "manual cleanup destination proof complete" });
        }
      },
    );
  },
);
