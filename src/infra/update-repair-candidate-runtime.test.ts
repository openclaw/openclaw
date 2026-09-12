import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { assertSupportedStateSchemaVersion } from "../state/openclaw-state-db-schema-version.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { prepareUnattendedUpdateRepair } from "./update-repair-agent.js";

describe("candidate repair runtime ownership", () => {
  it("lets the candidate read its migrated copy without reopening it in the older parent", async () => {
    await withOpenClawTestState(
      { prefix: "repair-schema-boundary-", layout: "split" },
      async (state) => {
        await state.writeConfig({ plugins: { enabled: false } });
        const candidateRoot = state.path("candidate");
        const copiedState = state.path("rehearsal");
        const copiedDatabase = path.join(copiedState, "state", "openclaw.sqlite");
        const copiedConfig = path.join(copiedState, "openclaw.json");
        await fs.mkdir(path.dirname(copiedDatabase), { recursive: true });
        await fs.copyFile(state.configPath, copiedConfig);
        const database = openNodeSqliteDatabase(copiedDatabase);
        database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
        database.close();
        const workerDir = path.join(candidateRoot, "dist", "infra");
        await fs.mkdir(workerDir, { recursive: true });
        // This fixture represents the next runtime's schema contract. The parent
        // oracle advances the copy first, exactly as candidate Doctor does.
        await fs.writeFile(
          path.join(workerDir, "update-repair.worker.js"),
          `
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
let start;
process.on("message", message => {
  if (message.type === "start") {
    start = message;
    assert.equal(start.context.phase, "validating");
    assert.equal(process.cwd(), start.target.installRoot);
    assert.notEqual(process.env.OPENCLAW_STATE_DIR, start.target.stateDir);
    assert.notEqual(process.env.HOME, start.target.environment.HOME);
    process.send({ type: "validate", id: 1 });
  } else if (message.type === "validation-result") {
    const db = new DatabaseSync(path.join(start.target.stateDir, "state", "openclaw.sqlite"), { readOnly: true });
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, ${OPENCLAW_STATE_SCHEMA_VERSION + 1});
    db.close();
    process.send({ type: "result", result: {
      status: "unrepaired", attempts: [], finalValidation: message.validation,
      reason: "Candidate runtime read the migrated copy."
    } }, () => process.disconnect());
  }
});
process.send({ type: "ready", candidateRehearsal: true });
`,
        );
        const originalConfig = await fs.readFile(state.configPath);
        const validate = vi.fn(async () => {
          const migrated = openNodeSqliteDatabase(copiedDatabase);
          try {
            migrated.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
            expect(() => assertSupportedStateSchemaVersion(migrated, copiedDatabase)).toThrow(
              `newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
            );
          } finally {
            migrated.close();
          }
          return { ok: false, score: 0, summary: "Candidate lint failed after migration." };
        });
        const result = await prepareUnattendedUpdateRepair({
          admissionEnv: state.env,
          target: {
            stateDir: copiedState,
            configPath: copiedConfig,
            workspaceDir: state.workspaceDir,
            installRoot: candidateRoot,
            environment: { ...state.env, HOME: state.path("copied-home") },
          },
          context: { error: "Candidate lint failed", phase: "validating" },
          budget: { wallClockMs: 10_000 },
          validate,
        });
        expect(result).toMatchObject({
          status: "unrepaired",
          reason: "Candidate runtime read the migrated copy.",
        });
        expect(validate).toHaveBeenCalledOnce();
        expect(await fs.readFile(state.configPath)).toEqual(originalConfig);
      },
    );
  });

  it("records an unsupported released worker before requesting validation", async () => {
    await withOpenClawTestState({ prefix: "repair-old-worker-", layout: "home" }, async (state) => {
      const workerDir = path.join(state.workspaceDir, "dist", "infra");
      await fs.mkdir(workerDir, { recursive: true });
      await fs.writeFile(
        path.join(workerDir, "update-repair.worker.js"),
        'process.on("message", () => process.send({ type: "validate", id: 1 })); process.send({ type: "ready" });',
      );
      const validate = vi.fn();
      const result = await prepareUnattendedUpdateRepair({
        target: { ...state, installRoot: state.workspaceDir },
        context: { error: "Candidate validation failed.", phase: "validating" },
        budget: { wallClockMs: 10_000 },
        validate,
      });
      expect(result).toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining("cannot repair isolated rehearsal state"),
      });
      expect(validate).not.toHaveBeenCalled();
    });
  });
});
