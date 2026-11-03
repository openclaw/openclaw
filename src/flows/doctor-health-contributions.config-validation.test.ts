import fs from "node:fs";
import nodePath from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  setupDoctorHealthContributionsFixture,
  mocks,
  requireDoctorContribution,
  createDoctorContext,
  createDoctorLintFixture,
} from "./doctor-health-contributions-suite.test-support.js";
import { resolveDoctorHealthContributions } from "./doctor-health-contributions.test-support.js";
import { runDoctorLintChecks } from "./doctor-lint-flow.js";
import type { HealthCheck } from "./health-checks.js";

// Install shared mocks before the production imports, regardless of import sorting.
await vi.hoisted(() => import("./doctor-health-contributions-suite.test-support.js"));

describe("doctor health contributions", () => {
  setupDoctorHealthContributionsFixture();

  describe("write-config lint findings", () => {
    const writeConfigContribution = requireDoctorContribution("doctor:write-config");
    const check = writeConfigContribution.healthChecks[0] as HealthCheck & {
      defaultEnabled?: boolean;
    };

    function lintWriteConfig(configPath = "/tmp/openclaw-home/openclaw.json") {
      return runDoctorLintChecks(createDoctorLintFixture({}, { configPath }), {
        checks: [check],
        onlyIds: ["core/doctor/write-config"],
      });
    }

    it("reports Nix immutable config mode when selected", async () => {
      vi.stubEnv("OPENCLAW_NIX_MODE", "1");

      await expect(lintWriteConfig("/tmp/fake-openclaw.json")).resolves.toMatchObject({
        checksRun: 1,
        checksSkipped: 0,
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/write-config",
            message: "Doctor config writes are disabled because OpenClaw is running in Nix mode.",
            path: "/tmp/fake-openclaw.json",
            requirement: "mutable-config-write-path",
          }),
        ],
      });
    });

    it("reports externally managed immutable config mode when selected", async () => {
      vi.stubEnv("OPENCLAW_CONFIG_READONLY", "1");

      await expect(lintWriteConfig("/tmp/fake-openclaw.json")).resolves.toMatchObject({
        checksRun: 1,
        checksSkipped: 0,
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/write-config",
            message: "Doctor config writes are disabled because config is externally managed.",
            path: "/tmp/fake-openclaw.json",
            requirement: "mutable-config-write-path",
          }),
        ],
      });
    });

    it("reports an unwritable config directory for an existing config", async () => {
      const configPath = "/tmp/openclaw-home/openclaw.json";
      vi.spyOn(fs, "existsSync").mockImplementation((path) => path === configPath);
      vi.spyOn(fs, "statSync").mockReturnValue({
        isDirectory: () => true,
      } as fs.Stats);
      vi.spyOn(fs, "accessSync").mockImplementation(() => {
        throw new Error("EACCES");
      });

      await expect(lintWriteConfig(configPath)).resolves.toMatchObject({
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/write-config",
            path: "/tmp/openclaw-home",
            target: configPath,
            requirement: "writable-config-directory",
          }),
        ],
      });
    });

    it("reports an existing parent without search permission", async () => {
      const configPath = nodePath.join(process.cwd(), ".doctor-missing-x/openclaw.json");
      vi.spyOn(fs, "accessSync").mockImplementation((_path, mode) => {
        if (mode === (fs.constants.W_OK | fs.constants.X_OK)) {
          throw new Error("EACCES");
        }
      });

      await expect(lintWriteConfig(configPath)).resolves.toMatchObject({
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/write-config",
            path: process.cwd(),
            target: nodePath.dirname(configPath),
            requirement: "writable-config-directory",
          }),
        ],
      });
    });

    it("reports a dangling symlink that blocks the config directory path", async () => {
      vi.spyOn(fs, "existsSync").mockImplementation((path) => path === "/tmp");
      vi.spyOn(fs, "lstatSync").mockImplementation((path) => {
        if (path === "/tmp/openclaw-home") {
          return { isDirectory: () => false } as fs.Stats;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      vi.spyOn(fs, "statSync").mockImplementation(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);

      await expect(lintWriteConfig()).resolves.toMatchObject({
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/write-config",
            path: "/tmp/openclaw-home",
            target: "/tmp/openclaw-home",
            requirement: "config-directory-path",
          }),
        ],
      });
      expect(accessSpy).not.toHaveBeenCalled();
    });
  });

  describe("config size drops during update", () => {
    const existsSync = fs.existsSync;
    const preUpdateBackupPath = "/tmp/fake-openclaw.json.pre-update";

    beforeEach(() => {
      mocks.replaceConfigFile.mockReset().mockResolvedValue(undefined);
      mocks.applyWizardMetadata.mockImplementation((cfg: unknown) => cfg);
      vi.spyOn(fs, "existsSync").mockImplementation((value) =>
        String(value) === preUpdateBackupPath ? false : existsSync(value),
      );
    });

    function buildWriteConfigCtx(env: Record<string, string | undefined>) {
      const cfg: OpenClawConfig = { gateway: { mode: "local" } };
      return createDoctorContext({
        cfg,
        cfgForPersistence: { gateway: { mode: "remote" } },
        configResult: {
          cfg,
          shouldWriteConfig: true,
          skipPluginValidationOnWrite: false,
        },
        shouldRepair: true,
        env,
      });
    }

    const writeConfigContribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:write-config",
    )!;

    it("preserves source config version for legacy parent writable update doctor writes", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      ctx.configResult.sourceLastTouchedVersion = "2026.5.16-beta.4";

      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            auditOrigin: "doctor",
            allowConfigSizeDrop: true,
            skipPluginValidation: true,
            lastTouchedVersionOverride: "2026.5.16-beta.4",
          }),
        }),
      );
    });

    it("consumes committed roster format while preserving later explicit edits", async () => {
      const ctx = buildWriteConfigCtx({});
      ctx.cfg.agents = { ownership: "explicit", entries: { default: {} } };
      ctx.configResult.persistCanonicalAgentRoster = true;
      ctx.configResult.explicitSetPaths = [["agents", "ownership"]];

      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            persistCanonicalAgentRoster: true,
            explicitSetPaths: [["agents", "ownership"]],
          }),
        }),
      );

      expect(ctx.configResultWriteCommitted).toBe(true);
      expect(ctx.configResult.persistCanonicalAgentRoster).toBe(true);

      ctx.cfg = { ...ctx.cfg, gateway: { mode: "remote" } };
      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
      expect(mocks.replaceConfigFile).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            persistCanonicalAgentRoster: undefined,
            explicitSetPaths: [["agents", "ownership"]],
          }),
        }),
      );
    });

    it("points update-time config rewrites at the pre-update backup", async () => {
      vi.mocked(fs.existsSync).mockImplementation(
        (value) => String(value) === preUpdateBackupPath || existsSync(value),
      );
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });

      await writeConfigContribution.run(ctx);

      expect(ctx.runtime.log).toHaveBeenCalledWith(
        "Update changed config; pre-update backup: /tmp/fake-openclaw.json.pre-update",
      );
    });

    it.each(["invalid config", "required deferred", "conditional deferred"] as const)(
      "records final validation blockers: %s",
      async (failure) => {
        const ctx = createDoctorContext({
          cfg: {},
          cfgForPersistence: {},
          configResult: { cfg: {} },
          shouldRepair: true,
        });
        if (failure === "invalid config") {
          mocks.readConfigFileSnapshot.mockResolvedValueOnce({
            exists: true,
            valid: false,
            sourceConfig: {},
            config: {},
            issues: [{ path: "retired.key", message: "Unsupported setting" }],
          });
        } else {
          ctx.configResult.stateMigrationStepReceipts = [
            {
              id: "fixture-required-migration",
              phase: "final",
              source: [{ kind: "owner", id: "fixture" }],
              target: [{ kind: "owner", id: "fixture" }],
              requiredness: failure === "required deferred" ? "required" : "conditional",
              reversibility: "checkpoint-required",
              outcome: "deferred",
              changes: [],
              warnings: ["Fixture migration blocked"],
            },
          ];
        }
        await requireDoctorContribution("doctor:final-config-validation").run(ctx);
        if (failure === "conditional deferred") {
          expect(ctx.postInstallDoctorResult).toBeUndefined();
          expect(ctx.runtime.error).not.toHaveBeenCalled();
        } else {
          expect(ctx.postInstallDoctorResult).toMatchObject({
            status: "error",
            failureFacts: [
              expect.objectContaining({
                code: failure === "invalid config" ? "valid-config" : "required-migration-deferred",
              }),
            ],
          });
          expect(ctx.runtime.log).toHaveBeenCalledWith(expect.stringContaining("doctor --fix"));
        }
      },
    );

    it("skips plugin schema validation for final validation during update doctor runs", async () => {
      const contribution = requireDoctorContribution("doctor:final-config-validation");

      await contribution.run(
        createDoctorContext({
          cfg: {},
          cfgForPersistence: {},
          configResult: { cfg: {} },
          shouldRepair: true,
          env: {
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
          },
        }),
      );

      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ skipPluginValidation: true }),
      );
    });
  });
});
