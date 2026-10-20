// Doctor repair flow tests cover repair plan output and repair execution.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runDoctorHealthRepairs } from "./doctor-repair-flow.js";
import { normalizeHealthCheck } from "./health-check-adapter.js";
import type { DoctorHealthCheck } from "./health-check-runner-types.js";
import type { HealthFinding, HealthRepairContext } from "./health-checks.js";

function ctx(cfg: OpenClawConfig): HealthRepairContext {
  return {
    mode: "fix",
    runtime: {
      log() {},
      error() {},
      exit() {},
    },
    cfg,
  };
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
  return normalizeHealthCheck({
    id: "test/repaired-first",
    kind: "core",
    description: "repairs before the unresolved check",
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
  it("reports repair validation findings that remain after repair", async () => {
    const checks: DoctorHealthCheck[] = [
      normalizeHealthCheck({
        id: "test/not-fixed",
        kind: "core",
        description: "not fixed",
        async detect() {
          return [
            {
              checkId: "test/not-fixed",
              severity: "warning",
              message: "still broken",
              ocPath: "oc://openclaw.json/gateway.mode",
            },
          ];
        },
        async repair() {
          return {
            changes: ["Tried repair."],
          };
        },
      }),
    ];

    const result = await runDoctorHealthRepairs(ctx({}), { checks });

    expect(result.remainingFindings).toMatchObject([
      {
        checkId: "test/not-fixed",
        ocPath: "oc://openclaw.json/gateway.mode",
      },
    ]);
    expect(result.warnings).toEqual(["test/not-fixed repair left 1 finding(s)"]);
  });

  it.each(["skipped", "throws", "unavailable", "validation-failed"] as const)(
    "preserves unresolved split findings after a successful sibling repair (%s)",
    async (outcome) => {
      const unresolvedId = `test/split-${outcome}`;
      const unresolvedCheck = normalizeHealthCheck({
        id: unresolvedId,
        kind: "core",
        description: "unresolved split check",
        async detect(_checkContext, scope) {
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
                if (outcome === "skipped") {
                  return { status: outcome, reason: "manual repair required", changes: [] };
                }
                return { changes: ["Attempted unresolved repair."] };
              },
            }),
      });

      const result = await runDoctorHealthRepairs(ctx({}), {
        checks: [successfullyRepairedCheck(), unresolvedCheck],
      });

      expect(result.config.gateway?.mode).toBe("local");
      expect(result.findings.map((finding) => finding.checkId)).toEqual([
        "test/repaired-first",
        unresolvedId,
      ]);
      expect(result.remainingFindings).toEqual([warningFinding(unresolvedId)]);
      if (outcome === "throws") {
        expect(result.warnings).toEqual([`${unresolvedId} repair failed: repair unavailable`]);
      }
    },
  );

  it("supports dry-run repairs without applying returned config or validating", async () => {
    const repairContexts: HealthRepairContext[] = [];
    let detectCalls = 0;
    const checks: DoctorHealthCheck[] = [
      normalizeHealthCheck({
        id: "test/dry-run",
        kind: "core",
        description: "dry run",
        async detect(ctxResult) {
          detectCalls++;
          return ctxResult.cfg.gateway?.mode === "local"
            ? []
            : [
                {
                  checkId: "test/dry-run",
                  severity: "warning",
                  message: "gateway mode missing",
                  path: "gateway.mode",
                },
              ];
        },
        async repair(ctxValue) {
          repairContexts.push(ctxValue);
          return {
            config: { ...ctxValue.cfg, gateway: { ...ctxValue.cfg.gateway, mode: "local" } },
            changes: ["Would set gateway.mode to local."],
            diffs: [
              {
                kind: "config",
                path: "gateway.mode",
                before: undefined,
                after: "local",
              },
            ],
            effects: [
              {
                kind: "config",
                action: "would-set",
                target: "gateway.mode",
                dryRunSafe: true,
              },
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
