import { describe, expect, it } from "vitest";
import { createConfigFileSnapshot } from "../../config/io.snapshot-shared.js";
import { createUpdateConfigFailure } from "./update-command-config-failure.js";

describe("update config failure guidance", () => {
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
          "split the canonical config back into includes and validate again",
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
