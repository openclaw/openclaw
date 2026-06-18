/** Tests system.run allowlist planning, output truncation, and argv resolution. */
import { describe, expect, it } from "vitest";
import { resolveExecApprovalsFromFile } from "../infra/exec-approvals.js";
import { planShellAuthorization } from "../infra/exec-authorization-plan.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import { resolveSystemRunExecArgv } from "./invoke-system-run-allowlist.js";

function resolveAllowlistApprovals() {
  return resolveExecApprovalsFromFile({
    file: {
      version: 1,
      defaults: {
        security: "allowlist",
        ask: "off",
        askFallback: "deny",
      },
    },
  });
}

describe("resolveSystemRunExecArgv", () => {
  it.runIf(process.platform !== "win32")(
    "fails closed when shell rewriting has no authorization plan",
    async () => {
      const env = { PATH: "/usr/bin:/bin" };

      const result = await resolveSystemRunExecArgv({
        plannedAllowlistArgv: undefined,
        argv: ["/bin/sh", "-lc", "head -c 16"],
        security: "allowlist",
        approvals: resolveAllowlistApprovals(),
        safeBins: new Set(),
        safeBinProfiles: {},
        trustedSafeBinDirs: new Set(),
        skillBins: [],
        autoAllowSkills: false,
        isWindows: false,
        policy: {
          approvedByAsk: false,
          analysisOk: true,
          allowlistSatisfied: true,
        },
        shellCommand: "head -c 16",
        segments: [],
        segmentSatisfiedBy: ["safeBins"],
        authorizationPlan: undefined,
        cwd: undefined,
        env,
      });

      expect(result).toBeNull();
    },
  );

  it.runIf(process.platform !== "win32")(
    "returns rebuilt shell argv when the authorization plan supports rewriting",
    async () => {
      const env = { PATH: "/usr/bin:/bin" };
      const authorizationPlan = await planShellAuthorization({
        command: "head -c 16",
        env,
        platform: process.platform,
      });
      expect(authorizationPlan.ok).toBe(true);
      if (!authorizationPlan.ok) {
        throw new Error(authorizationPlan.reason);
      }
      const safeBinPolicy = resolveExecSafeBinRuntimePolicy({
        global: { safeBins: ["head"] },
      });

      const result = await resolveSystemRunExecArgv({
        plannedAllowlistArgv: undefined,
        argv: ["/bin/sh", "-lc", "head -c 16"],
        security: "allowlist",
        approvals: resolveAllowlistApprovals(),
        safeBins: safeBinPolicy.safeBins,
        safeBinProfiles: safeBinPolicy.safeBinProfiles,
        trustedSafeBinDirs: safeBinPolicy.trustedSafeBinDirs,
        skillBins: [],
        autoAllowSkills: false,
        isWindows: false,
        policy: {
          approvedByAsk: false,
          analysisOk: true,
          allowlistSatisfied: true,
        },
        shellCommand: "head -c 16",
        segments: authorizationPlan.groups.flatMap((group) =>
          group.candidates.map((candidate) => candidate.sourceSegment),
        ),
        segmentSatisfiedBy: ["safeBins"],
        authorizationPlan,
        cwd: undefined,
        env,
      });

      expect(result).not.toBeNull();
      expect(result?.[0]).toBe("/bin/sh");
      expect(result?.[2]).toBe("/usr/bin/head -c 16");
    },
  );
});
