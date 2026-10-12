import "./doctor-health.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { expect, it, vi } from "vitest";
import * as doctorConfigFlow from "../commands/doctor-config-flow.js";
import { runDoctorConfigPreflight } from "../commands/doctor-config-preflight.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertNoRetiredStateFiles } from "../infra/state-migrations.retired-files.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useDoctorHealthFixture } from "./doctor-health.fixture.test-support.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

useDoctorHealthFixture();
const { mocks } = await import("./doctor-health.test-support.js");

it.each(["before", "after"])(
  "preserves schema when retired state refuses %s migration",
  async (phase) => {
    await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
      await state.writeConfig({ gateway: { mode: "local" }, plugins: { enabled: false } });
      const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
      await closeOpenClawStateDatabaseAsync();
      const database = openNodeSqliteDatabase(databasePath);
      database.exec(
        "PRAGMA user_version = 16; UPDATE schema_meta SET schema_version = 16 WHERE meta_key = 'primary';",
      );
      database.close();
      const sidecarId = "a".repeat(32);
      const authPath = path.join(state.agentDir(), "auth-profiles.json");
      const sidecarPath = state.statePath("credentials", "auth-profiles", `${sidecarId}.json`);
      const writeSidecar = async () => {
        await fs.mkdir(path.dirname(authPath), { recursive: true });
        await fs.writeFile(
          authPath,
          JSON.stringify({
            profiles: {
              "openai-codex:default": {
                type: "oauth",
                provider: "openai-codex",
                oauthRef: {
                  source: "openclaw-credentials",
                  provider: "openai-codex",
                  id: sidecarId,
                },
              },
            },
          }),
        );
        await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
        await fs.writeFile(sidecarPath, '{"version":1,"access":"synthetic-retired-token"}\n');
      };
      if (phase === "before") {
        await writeSidecar();
      } else {
        mocks.runContributions.mockImplementationOnce(async () => {
          await writeSidecar();
          assertNoRetiredStateFiles("OAuth credential sidecars", [sidecarPath]);
        });
      }
      const original = await fs.readFile(databasePath);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      mocks.config.mockReturnValue({ gateway: { mode: "local" }, plugins: { enabled: false } });
      const loadConfig = doctorConfigFlow.loadAndMaybeMigrateDoctorConfig;
      const configFlow = vi.spyOn(doctorConfigFlow, "loadAndMaybeMigrateDoctorConfig");
      configFlow.mockImplementation(async (params) => {
        if (phase === "before") {
          await runDoctorConfigPreflight({ doctorOnlyStateMigrations: true });
        }
        return loadConfig(params);
      });

      let refusal: unknown;
      try {
        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
      } catch (error) {
        refusal = error;
      } finally {
        configFlow.mockRestore();
      }
      expect(refusal).toBeInstanceOf(Error);
      expect(String(refusal)).toContain("Upgrade through OpenClaw 2026.9.7");

      await closeOpenClawStateDatabaseAsync();
      const preserved = openNodeSqliteDatabase(databasePath, { readOnly: true });
      try {
        expect(
          preserved.prepare("PRAGMA user_version").get(),
          inspect({ refusal, logs: runtime.log.mock.calls, errors: runtime.error.mock.calls }),
        ).toEqual({ user_version: 16 });
      } finally {
        preserved.close();
      }
      if (phase === "before") {
        expect(await fs.readFile(databasePath)).toEqual(original);
      } else {
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("Restored this Doctor run"),
        );
      }
      expect(await fs.readFile(sidecarPath, "utf8")).toContain("synthetic-retired-token");
    });
  },
);
