import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runDoctorHealthRepairs } from "./doctor-repair-flow.js";
import { normalizeHealthCheck } from "./health-check-adapter.js";
import type { DoctorHealthCheck } from "./health-check-runner-types.js";
import type { HealthFinding, HealthRepairContext } from "./health-checks.js";

function ctx(cfg: OpenClawConfig): HealthRepairContext {
  return { mode: "fix", runtime: { log() {}, error() {}, exit() {} }, cfg };
}

function check(
  id: string,
  handlers: Pick<DoctorHealthCheck, "detect"> & Partial<Pick<DoctorHealthCheck, "repair">>,
  description = id,
) {
  return normalizeHealthCheck({ id, kind: "core", description, ...handlers });
}

function warningFinding(checkId: string): HealthFinding {
  return {
    checkId,
    severity: "warning",
    message: `Unresolved finding from ${checkId}.`,
    path: checkId,
  };
}

function successfullyRepairedCheck(): DoctorHealthCheck {
  return check("test/repaired-first", {
    async detect(checkContext) {
      return checkContext.cfg.gateway?.mode === "local"
        ? []
        : [warningFinding("test/repaired-first")];
    },
    async repair(checkContext) {
      return {
        config: { ...checkContext.cfg, gateway: { ...checkContext.cfg.gateway, mode: "local" } },
        changes: ["Set gateway.mode to local."],
      };
    },
  });
}

describe("runDoctorHealthRepairs", () => {
  it.each([
    "skipped",
    "failed",
    "throws",
    "detect-throws",
    "unavailable",
    "validation-failed",
  ] as const)(
    "preserves unresolved split findings after a successful sibling repair (%s)",
    async (outcome) => {
      const unresolvedId = `test/split-${outcome}`;
      let detectCalls = 0;
      const unresolvedCheck = check(
        unresolvedId,
        {
          async detect(_checkContext, scope) {
            detectCalls++;
            if (outcome === "detect-throws") {
              throw new Error("inspection unavailable");
            }
            if (outcome === "validation-failed" && scope !== undefined) {
              throw new Error("validation unavailable");
            }
            return [warningFinding(unresolvedId)];
          },
          ...(outcome === "unavailable"
            ? {}
            : {
                async repair() {
                  if (outcome === "throws") {
                    throw new Error("repair unavailable");
                  }
                  if (outcome === "skipped" || outcome === "failed") {
                    return {
                      status: outcome,
                      reason: "manual repair required",
                      changes: ["Review required before changing gateway.mode."],
                    };
                  }
                  return { changes: ["Attempted unresolved repair."] };
                },
              }),
        },
        "unresolved split check",
      );

      const result = await runDoctorHealthRepairs(ctx({}), {
        checks: [successfullyRepairedCheck(), unresolvedCheck],
      });

      expect(result.config.gateway?.mode).toBe("local");
      expect(result.findings.map((finding) => finding.checkId)).toEqual([
        "test/repaired-first",
        unresolvedId,
      ]);
      if (outcome === "detect-throws") {
        expect(result.remainingFindings).toMatchObject([
          {
            checkId: unresolvedId,
            category: "fix-now",
            message: "Doctor could not complete unresolved split check: inspection unavailable",
            fixHint: expect.stringContaining("rerun openclaw doctor"),
            docsUrl: "https://docs.openclaw.ai/cli/doctor/running#understanding-findings",
          },
        ]);
        expect(result.warnings).toEqual([`${unresolvedId} detect failed: inspection unavailable`]);
      } else {
        expect(result.remainingFindings).toEqual([warningFinding(unresolvedId)]);
      }

      if (outcome === "throws") {
        expect(result.warnings).toEqual([`${unresolvedId} repair failed: repair unavailable`]);
      }
      if (outcome === "skipped" || outcome === "failed") {
        expect(detectCalls).toBe(1);
        expect(result.changes).toEqual([
          "Set gateway.mode to local.",
          "Review required before changing gateway.mode.",
        ]);
        expect(result.warnings).toEqual([
          `${unresolvedId} repair ${outcome}: manual repair required`,
        ]);
      }
    },
  );

  it("supports dry-run repairs without applying returned config or validating", async () => {
    const repairContexts: HealthRepairContext[] = [];
    let detectCalls = 0;
    const checks = [
      check("test/dry-run", {
        async detect(ctxResult) {
          detectCalls++;
          return ctxResult.cfg.gateway?.mode === "local"
            ? []
            : [{ ...warningFinding("test/dry-run"), path: "gateway.mode" }];
        },
        async repair(ctxValue) {
          repairContexts.push(ctxValue);
          return {
            config: { ...ctxValue.cfg, gateway: { ...ctxValue.cfg.gateway, mode: "local" } },
            changes: ["Would set gateway.mode to local."],
            diffs: [{ kind: "config", path: "gateway.mode", before: undefined, after: "local" }],
            effects: [
              { kind: "config", action: "would-set", target: "gateway.mode", dryRunSafe: true },
            ],
          };
        },
      }),
    ];

    const result = await runDoctorHealthRepairs(ctx({}), {
      checks,
      dryRun: true,
      diff: true,
    });

    expect(result.config).toEqual({});
    expect(result.changes).toEqual(["Would set gateway.mode to local."]);
    expect(result.diffs).toMatchObject([{ kind: "config", path: "gateway.mode" }]);
    expect(result.effects).toMatchObject([{ kind: "config", action: "would-set" }]);

    expect(detectCalls).toBe(1);
    expect(repairContexts[0]).toMatchObject({ dryRun: true, diff: true });
  });
});
