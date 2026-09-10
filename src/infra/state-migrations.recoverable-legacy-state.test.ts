import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import {
  coercePluginDoctorContractModule,
  type PluginDoctorContractModule,
} from "../plugins/doctor-contract-module.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createLegacyStateMigrationStepReceipt,
  throwIfDoctorStateMigrationRefused,
} from "./state-migrations.messages.js";
import { createPluginDoctorStateMigrationContext } from "./state-migrations.plugin-doctor-context.js";
import { runLegacyMigrationPlans } from "./state-migrations.plugin-state.js";
import type { MigrationMessages } from "./state-migrations.types.js";
import { migrateLegacyUpdateCheckState } from "./state-migrations.update-check.js";

function migrationReceipt(id: string, result: MigrationMessages) {
  return createLegacyStateMigrationStepReceipt(
    {
      id,
      phase: "shared",
      source: [],
      target: [],
      requiredness: "required",
      reversibility: "checkpoint-required",
    },
    result,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
});

describe("recoverable legacy state", () => {
  it.each([
    { failure: "malformed", canonical: true },
    { failure: "unreadable", canonical: true },
    { failure: "malformed", canonical: false },
    { failure: "unreadable", canonical: false },
  ])(
    "keeps $failure update metadata advisory only with canonical state=$canonical",
    async ({ failure, canonical }) => {
      await withOpenClawTestState({ label: "update-check-recovery" }, async ({ stateDir, env }) => {
        const sourcePath = path.join(stateDir, "update-check.json");
        const sourceBytes = failure === "malformed" ? "{invalid legacy JSON" : "{}";
        await fs.writeFile(sourcePath, sourceBytes);
        const canonicalState = {
          autoInstallId: "canonical-install",
          autoFirstSeenVersion: "2026.9.3",
          autoFirstSeenAt: "2026-09-08T00:00:00.000Z",
          autoLastAttemptVersion: "2026.9.3",
          autoLastAttemptAt: "2026-09-08T01:00:00.000Z",
        };
        if (canonical) {
          writeConfigMachineState("update.checkState", canonicalState, { env });
        }
        if (failure === "unreadable") {
          const readFile = fsSync.readFileSync;
          vi.spyOn(fsSync, "readFileSync").mockImplementation((target, options) => {
            if (target === sourcePath) {
              throw new Error("synthetic legacy cache permission denied");
            }
            return readFile(target, options);
          });
        }

        const result = migrateLegacyUpdateCheckState({
          stateDir,
          detected: { sourcePath, hasLegacy: true },
        });
        const receipt = migrationReceipt("update-check", result);

        await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(sourceBytes);
        expect(readConfigMachineState("update.checkState", { env })).toEqual(
          canonical ? canonicalState : undefined,
        );
        expect(receipt.warnings.join("\n")).toContain("update-check");
        if (canonical) {
          expect(() => throwIfDoctorStateMigrationRefused([receipt])).not.toThrow();
          expect(receipt.outcome).toBe("warning");
          expect(receipt.warnings.join("\n")).toContain("openclaw doctor --fix");
        } else {
          expect(() => throwIfDoctorStateMigrationRefused([receipt])).toThrow(
            "Doctor stopped because a state migration refused",
          );
          expect(receipt.outcome).toBe("refused");
        }
        vi.restoreAllMocks();
      });
    },
  );

  it.each([false, true])(
    "keeps Discord cache cleanup advisory unless another import fails (%s)",
    async (failedImport) => {
      await withOpenClawTestState({ label: "discord-cache-cleanup" }, async ({ stateDir, env }) => {
        const discordDir = path.join(stateDir, "discord");
        const sourcePath = path.join(discordDir, "command-deploy-cache.json");
        await fs.mkdir(discordDir, { recursive: true });
        await fs.writeFile(sourcePath, "retired deploy hashes");
        if (failedImport) {
          await fs.writeFile(path.join(discordDir, "thread-bindings.json"), "{}");
        }
        const unlink = fsSync.unlinkSync;
        vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
          if (target === sourcePath) {
            throw new Error("synthetic cache cleanup permission denied");
          }
          unlink(target);
        });
        const { stateMigrations } = coercePluginDoctorContractModule(
          await vi.importActual<PluginDoctorContractModule>(
            path.resolve("extensions/discord/doctor-contract-api.ts"),
          ),
        );
        const migration = expectDefined(stateMigrations?.[0], "Discord Doctor migration");
        const params = {
          config: {},
          env,
          stateDir,
          oauthDir: path.join(stateDir, "credentials"),
          context: createPluginDoctorStateMigrationContext({
            pluginId: "discord",
            env,
            config: {},
          }),
        };

        const result = await migration.migrateLegacyState(params);
        const receipt = migrationReceipt(migration.id, result);

        await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("retired deploy hashes");
        expect(receipt.warnings.join("\n")).toContain("Discord command deployment cache");
        expect(receipt.warnings.join("\n")).toContain("synthetic cache cleanup permission denied");
        if (failedImport) {
          expect(() => throwIfDoctorStateMigrationRefused([receipt])).toThrow(
            "Doctor stopped because a state migration refused",
          );
          expect(receipt.warnings.join("\n")).toContain("legacy Discord thread bindings store");
        } else {
          expect(() => throwIfDoctorStateMigrationRefused([receipt])).not.toThrow();
          expect(receipt.outcome).toBe("warning");
          expect(receipt.warnings.join("\n")).toContain("openclaw doctor --fix");
        }
        vi.restoreAllMocks();
        if (!failedImport) {
          expect((await migration.migrateLegacyState(params)).warnings).toEqual([]);
          await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );

  it("keeps a shared source blocked when another cleanup owner does not opt in", async () => {
    await withOpenClawTestState({ label: "shared-cleanup-policy" }, async ({ stateDir }) => {
      const sourcePath = path.join(stateDir, "shared-cache.json");
      await fs.writeFile(sourcePath, "retained source");
      const unlink = fsSync.unlinkSync;
      vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
        if (target === sourcePath) {
          throw new Error("synthetic shared cleanup failure");
        }
        unlink(target);
      });

      const result = await runLegacyMigrationPlans(
        ["optional", "required"].map((namespace) => ({
          kind: "plugin-state-import",
          label: `${namespace} state`,
          sourcePath,
          targetPath: `plugin state:${namespace}`,
          pluginId: "cleanup-fixture",
          namespace,
          stateDir,
          maxEntries: 10,
          scopeKey: "",
          cleanupSource: "remove",
          cleanupWhenEmpty: true,
          cleanupWarningDisposition: namespace === "optional" ? "recoverable" : undefined,
          readEntries: () => [],
        })),
      );

      const receipt = migrationReceipt("shared-cleanup", result);
      expect(() => throwIfDoctorStateMigrationRefused([receipt])).toThrow(
        "Doctor stopped because a state migration refused",
      );
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("retained source");
      vi.restoreAllMocks();
    });
  });
});
