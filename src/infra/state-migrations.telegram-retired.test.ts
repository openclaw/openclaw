import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  coercePluginDoctorContractModule,
  type PluginDoctorContractModule,
  type PluginDoctorStateMigration,
} from "../plugins/doctor-contract-module.js";
import {
  createLegacyStateMigrationStepReceipt,
  DoctorStateMigrationRefusalError,
  throwIfDoctorStateMigrationRefused,
} from "./state-migrations.messages.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let migration: PluginDoctorStateMigration;

beforeAll(async () => {
  const { stateMigrations } = coercePluginDoctorContractModule(
    await vi.importActual<PluginDoctorContractModule>(
      path.resolve("extensions/telegram/doctor-contract-api.ts"),
    ),
  );
  const selected = stateMigrations?.find((entry) => entry.id === "telegram-legacy-state");
  expect(selected).toBeDefined();
  migration = selected!;
});

describe("retired Telegram Doctor warning disposition", () => {
  it.each([
    { empty: true, nonempty: false },
    { empty: false, nonempty: true },
    { empty: true, nonempty: true },
  ])("preserves state and diagnostics (empty=$empty, nonempty=$nonempty)", async (fixture) => {
    const stateDir = tempDirs.make("openclaw-telegram-doctor-warnings-");
    const telegramDir = path.join(stateDir, "telegram");
    await fs.mkdir(telegramDir);
    const emptyPath = path.join(telegramDir, "thread-bindings-default.json");
    const nonemptyPath = path.join(telegramDir, "thread-bindings-private-account.json");
    const emptyBytes = '{"version":1,"bindings":[]}';
    const nonemptyBytes = '{"version":1,"bindings":[{"chatId":"123"}]}';
    if (fixture.empty) {
      await fs.writeFile(emptyPath, emptyBytes);
      await fs.mkdir(`${emptyPath}.migrated`);
    }
    if (fixture.nonempty) {
      await fs.writeFile(nonemptyPath, nonemptyBytes);
    }
    const result = await migration.migrateLegacyState({
      config: {},
      env: { OPENCLAW_STATE_DIR: stateDir },
      stateDir,
      oauthDir: path.join(stateDir, "credentials"),
      context: {
        openPluginStateKeyedStore() {
          throw new Error("retired source inspection must not open canonical stores");
        },
      },
    });
    const receipt = createLegacyStateMigrationStepReceipt(
      {
        id: "plugin-doctor-state",
        phase: "shared",
        source: [],
        target: [],
        requiredness: "required",
        reversibility: "checkpoint-required",
      },
      result,
    );
    expect(receipt.outcome).toBe(fixture.nonempty ? "refused" : "warning");
    if (fixture.empty) {
      expect(result.warnings).toContainEqual(expect.stringContaining("Failed archiving"));
      expect(await fs.readFile(emptyPath, "utf8")).toBe(emptyBytes);
    }
    if (fixture.nonempty) {
      const failure = new DoctorStateMigrationRefusalError([receipt]);
      const message = failure.failureFacts[0]?.message;
      expect(message).toContain("Telegram thread bindings may contain unmigrated data");
      expect(message).toContain("openclaw doctor --fix on 2026.9.5");
      expect(message).toContain("pre-update backup");
      expect(message).not.toContain(stateDir);
      expect(message).not.toContain("private-account");
      expect(await fs.readFile(nonemptyPath, "utf8")).toBe(nonemptyBytes);
    } else {
      expect(() => throwIfDoctorStateMigrationRefused([receipt])).not.toThrow();
    }
  });
});
