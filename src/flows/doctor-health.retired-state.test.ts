import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useDoctorHealthFixture } from "./doctor-health.fixture.test-support.js";
import { mocks } from "./doctor-health.test-support.js";

vi.doUnmock("../commands/doctor-config-flow.js");
const { runDoctorHealthFlow } = await import("./doctor-health.js");
const { materializeSharedStateDatabase } = useDoctorHealthFixture();

beforeEach(() => {
  mocks.packageRoot.mockReturnValue(undefined);
  mocks.runContributions.mockReset();
});

it.each(["referenced OAuth sidecar", "runtime sidecar"])(
  "preserves schema 16 when refusing a retired %s",
  async (kind) => {
    await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
      const cfg = { gateway: { mode: "local" as const }, plugins: { enabled: false } };
      await state.writeConfig(cfg);
      mocks.config.mockReturnValue(cfg);
      materializeSharedStateDatabase(state.env);
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      const database = openNodeSqliteDatabase(databasePath);
      database.exec("PRAGMA user_version = 16; UPDATE schema_meta SET schema_version = 16;");
      database.close();
      const retiredPath =
        kind === "runtime sidecar"
          ? state.statePath("settings/voicewake.json")
          : state.statePath(`credentials/auth-profiles/${"a".repeat(32)}.json`);
      fs.mkdirSync(path.dirname(retiredPath), { recursive: true });
      fs.writeFileSync(retiredPath, "{}\n");
      if (kind === "referenced OAuth sidecar") {
        const authPath = state.statePath("agents/main/agent/auth-profiles.json");
        fs.mkdirSync(path.dirname(authPath), { recursive: true });
        fs.writeFileSync(
          authPath,
          JSON.stringify({
            profiles: {
              "openai-codex:default": {
                type: "oauth",
                provider: "openai-codex",
                oauthRef: {
                  source: "openclaw-credentials",
                  provider: "openai-codex",
                  id: "a".repeat(32),
                },
              },
            },
          }),
        );
      }
      const before = fs.readFileSync(databasePath);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const failure = await runDoctorHealthFlow(runtime, {
        repair: true,
        nonInteractive: true,
      }).catch((error: unknown) => error);
      expect(String(failure)).toContain("Upgrade through OpenClaw 2026.9.7");
      const inspected = openNodeSqliteDatabase(databasePath, { readOnly: true });
      try {
        expect(inspected.prepare("PRAGMA user_version").get()?.user_version).toBe(16);
      } finally {
        inspected.close();
      }
      expect(fs.readFileSync(databasePath)).toEqual(before);
      expect(fs.readFileSync(retiredPath, "utf8")).toBe("{}\n");
      expect(String(failure)).not.toContain("persisted repair state is not ready");
    });
  },
);
