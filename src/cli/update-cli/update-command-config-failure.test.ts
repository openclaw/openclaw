import { describe, expect, it } from "vitest";
import { createConfigFileSnapshot } from "../../config/io.snapshot-shared.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import { createUpdateConfigFailure } from "./update-command-config-failure.js";

describe("update config failure guidance", () => {
  it.each([
    {
      code: "EACCES",
      contention: false,
      expectedCode: "EACCES",
      guidance: "Check configuration file access",
    },
    {
      code: null,
      contention: true,
      expectedCode: "gateway-maintenance-busy",
      guidance: "Wait for the active Gateway or maintenance operation",
    },
  ])(
    "preserves config access and live maintenance guidance ($expectedCode)",
    ({ code, contention, expectedCode, guidance }) => {
      const snapshot = createConfigFileSnapshot({
        path: "/fixture/openclaw.json",
        exists: true,
        raw: null,
        parsed: null,
        sourceConfig: {},
        runtimeConfig: {},
        valid: false,
        issues: [],
        warnings: [],
        legacyIssues: [],
        readError: { code },
      });
      const cause = contention
        ? new DoctorMaintenanceRefusalError("synthetic-private-owner", {
            kind: "deferred",
            reason: "coordinator-contention",
          })
        : undefined;
      const failure = createUpdateConfigFailure(snapshot, cause);
      expect(failure.reason).toBe("config-read-failed");
      expect(failure.failureFacts?.[0]?.code).toBe(expectedCode);
      expect(failure.nextAction).toContain(guidance);
      expect(failure.nextAction).not.toContain("recover-lock");
      expect(JSON.stringify(failure)).not.toContain("synthetic-private-owner");
    },
  );

  it.each([
    { path: "agents.list", included: true, manual: true, retired: false },
    { path: "agents.entries", included: true, manual: true, retired: false },
    { path: "agents.list", included: false, manual: false, retired: false },
    { path: "gateway.port", included: true, manual: false, retired: false },
    { path: "agents.list", included: true, manual: true, retired: true },
  ])(
    "preserves safe recovery guidance for $path (included=$included, retired=$retired)",
    ({ path, included, manual, retired }) => {
      const rejectedValue = "synthetic-private-rejected-value";
      const issue = { path, message: `Rejected ${rejectedValue}` };
      const originalConfig = {
        agents: {},
        ...(retired ? { heartbeat: { every: rejectedValue } } : {}),
      };
      const snapshot = createConfigFileSnapshot({
        path: "/fixture/openclaw.json",
        exists: true,
        raw: rejectedValue,
        parsed: {},
        sourceConfigBeforeMigrations: originalConfig,
        sourceConfig: {},
        runtimeConfig: {},
        valid: false,
        agentRosterIncludeOwned: included,
        issues: [issue],
        warnings: [],
        legacyIssues: [issue],
      });

      const failure = createUpdateConfigFailure(snapshot);

      expect(failure.reason).toBe("invalid-config");
      expect(failure.message).toContain(`${path}: Invalid configuration field`);
      expect(failure.message).toContain(failure.nextAction);
      if (retired) {
        expect(failure.message).toContain(
          "configuration contains retired fields that current Doctor cannot migrate",
        );
        expect(failure.nextAction).toMatch(
          /Install OpenClaw 2026\.9\.5[\s\S]*openclaw doctor --fix/,
        );
        expect(failure.nextAction).not.toContain("consolidate");
      } else if (manual) {
        expect(failure.nextAction).toContain(
          "Back up the root config, included files, and persisted state",
        );
        expect(failure.nextAction).toContain(
          "temporarily consolidate the original legacy config into one openclaw.json",
        );
        expect(failure.nextAction).toContain(
          "Preserve roster order, legacy markers, environment and secret references",
        );
        expect(failure.nextAction).toContain(
          "split the repaired config back into includes and validate again",
        );
        expect(failure.nextAction).toContain(
          "https://docs.openclaw.ai/gateway/doctor/config-migrations#agent-roster-migration",
        );
      } else {
        expect(failure.nextAction).toMatch(/^Run `openclaw doctor --fix`/);
        expect(failure.nextAction).not.toContain("consolidate");
      }
      expect(
        JSON.stringify({
          message: failure.message,
          nextAction: failure.nextAction,
          failureFacts: failure.failureFacts,
        }),
      ).not.toContain(rejectedValue);
    },
  );
});
