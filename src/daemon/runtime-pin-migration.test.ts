import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectServiceRuntimeIntent } from "../cli/daemon-cli/status.runtime-intent.js";
import { createConfigMachineStateStep } from "../infra/state-migrations.config-machine-state-step.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  readDaemonRuntimePin,
  readDaemonRuntimePinMigrationPending,
  withDaemonRuntimePinMigration,
} from "./runtime-pin-state.js";
import { withDaemonRuntimePinStore } from "./runtime-pin-store.js";
import { createMockGatewayService } from "./service.test-helpers.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
afterEach(() => vi.restoreAllMocks());

describe("runtime pin migration before service resume", () => {
  it.each([
    { entry: "resume", malformed: false },
    { entry: "resume", malformed: true },
    { entry: "post-update Doctor", malformed: false },
  ])(
    "preserves stored intent through $entry (malformed=$malformed)",
    async ({ entry, malformed }) => {
      await withOpenClawTestState({ label: "runtime-pin-resume" }, async (state) => {
        // Leave the receipt absent while creating private files on the actual host platform.
        withDaemonRuntimePinStore(state.env, true, () => undefined);
        vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
        vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(state.stateDir);
        const env = { ...state.env, OPENCLAW_LAUNCHD_LABEL: "dev.openclaw.migration-fixture" };
        const command = { programArguments: ["/fixture/node", "/fixture/openclaw.mjs", "gateway"] };
        const pin = { runtime: "node", path: "/fixture/node" };
        const stateKey = `daemon-runtime-pin:${digest(["gateway", "darwin", env.OPENCLAW_LAUNCHD_LABEL, state.configPath])}`;
        const valueJson = malformed
          ? "{ malformed"
          : JSON.stringify({
              version: 1,
              pin,
              definition: digest([command.programArguments, null]),
            });
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
              stateKey,
              valueJson,
              123,
            );
          },
          { env },
        );
        const service = createMockGatewayService();
        const status = () =>
          inspectServiceRuntimeIntent({
            kind: "gateway",
            service,
            command,
            env,
            serviceEnv: env,
            inspectionKnown: true,
          });

        if (entry === "resume") {
          expect(readDaemonRuntimePinMigrationPending(env)).toBe(true);
          expect((await status()).runtimeIntent).toEqual({
            status: "migrationPending",
            nextStep: "run openclaw doctor",
          });
          expect(() => readDaemonRuntimePin({ kind: "gateway", env }, command)).toThrow(
            "migration pending",
          );
        }
        let admitted = false;
        const readMigratedPin = () => {
          admitted = true;
          expect(readDaemonRuntimePinMigrationPending(env)).toBe(false);
          const stored = withDaemonRuntimePinStore(env, false, (db) =>
            db
              .prepare(
                "SELECT value_json, updated_at_ms FROM daemon_runtime_pins WHERE state_key = ?",
              )
              .get(stateKey),
          );
          expect(stored).toEqual({ value_json: valueJson, updated_at_ms: 123 });
          if (malformed) {
            expect(() => readDaemonRuntimePin({ kind: "gateway", env }, command)).toThrow();
          } else {
            expect(readDaemonRuntimePin({ kind: "gateway", env }, command).pin).toEqual(pin);
          }
        };
        if (entry === "resume") {
          await withDaemonRuntimePinMigration(env, readMigratedPin);
        } else {
          const result = await createConfigMachineStateStep({
            config: {},
            configPath: state.configPath,
            configIncludedPaths: [],
            stateDir: state.stateDir,
            env,
          }).run();
          expect(result.warnings).toEqual([]);
          readMigratedPin();
        }
        expect(admitted).toBe(true);
        expect((await status()).runtimeIntent.status).toBe(malformed ? "unknown" : "known");
        expect(
          runOpenClawStateWriteTransaction(
            ({ db }) =>
              db
                .prepare("SELECT state_key FROM config_machine_state WHERE state_key = ?")
                .get(stateKey),
            { env },
          ),
        ).toBeUndefined();
        expect(
          withDaemonRuntimePinStore(env, false, (db) =>
            db.prepare("SELECT source_state, phase FROM daemon_runtime_pin_migration").get(),
          ),
        ).toEqual({ source_state: resolveOpenClawStateSqlitePath(env), phase: "complete" });
      });
    },
  );

  it("treats another state root's complete receipt as pending", async () => {
    await withOpenClawTestState({ label: "runtime-pin-receipt-root" }, async (state) => {
      withDaemonRuntimePinStore(state.env, true, (db) => {
        db.prepare("INSERT INTO daemon_runtime_pin_migration VALUES (1, ?, 'complete', 1)").run(
          path.join(state.root, "other.sqlite"),
        );
      });
      expect(readDaemonRuntimePinMigrationPending(state.env)).toBe(true);
    });
  });

  it("does not admit the service callback when migration conflicts", async () => {
    await withOpenClawTestState({ label: "runtime-pin-conflict" }, async (state) => {
      vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(state.stateDir);
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
            "daemon-runtime-pin:conflict",
            "source",
            1,
          );
        },
        { env: state.env },
      );
      withDaemonRuntimePinStore(state.env, true, (db) => {
        db.prepare("INSERT INTO daemon_runtime_pins VALUES (?, ?, ?)").run(
          "daemon-runtime-pin:conflict",
          "target",
          2,
        );
      });
      let admitted = false;
      await expect(
        withDaemonRuntimePinMigration(state.env, () => {
          admitted = true;
        }),
      ).rejects.toThrow("migration conflict");
      expect(admitted).toBe(false);
      expect(readDaemonRuntimePinMigrationPending(state.env)).toBe(true);
    });
  });
});
