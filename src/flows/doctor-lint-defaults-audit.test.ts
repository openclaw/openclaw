// Doctor lint defaults audit keeps broad lint output intentional as coverage grows.
import { describe, expect, it } from "vitest";
import { resolveDoctorContributionHealthChecks } from "./doctor-health-contributions.js";
import { runDoctorLintChecks } from "./doctor-lint-flow.js";
import type { HealthCheck, HealthCheckContext } from "./health-checks.js";

type LintDefaultAuditReason = {
  readonly category: "broad-safe" | "explicit-only";
  readonly reason: string;
};

const DEFAULT_ENABLED_LINT_AUDIT = {
  "core/doctor/gateway-config": {
    category: "broad-safe",
    reason: "static config shape and local gateway config validation",
  },
  "core/doctor/claude-cli": {
    category: "broad-safe",
    reason: "local CLI availability check used by the base doctor flow",
  },
  "core/doctor/gateway-auth": {
    category: "broad-safe",
    reason: "static gateway auth configuration validation",
  },
  "core/doctor/command-owner": {
    category: "broad-safe",
    reason: "local ownership mismatch with an actionable setup fix",
  },
  "core/doctor/ui-protocol-freshness": {
    category: "broad-safe",
    reason: "local UI protocol freshness signal with established default behavior",
  },
  "core/doctor/codex-session-routes": {
    category: "broad-safe",
    reason: "local route compatibility check for active session behavior",
  },
  "core/doctor/sandbox/registry-files": {
    category: "broad-safe",
    reason: "local stale registry residue with an existing corrective path",
  },
  "core/doctor/gateway-services/extra": {
    category: "broad-safe",
    reason: "local extra service state that can confuse gateway ownership",
  },
  "core/doctor/gateway-services/platform-notes": {
    category: "broad-safe",
    reason: "platform-specific gateway service notes already emitted by default doctor",
  },
  "core/doctor/security": {
    category: "broad-safe",
    reason: "local security posture check with direct user action",
  },
  "core/doctor/browser": {
    category: "broad-safe",
    reason: "local browser readiness check with established default behavior",
  },
  "core/doctor/browser-clawd-profile-residue": {
    category: "broad-safe",
    reason: "local stale browser profile residue with a clear cleanup path",
  },
  "core/doctor/oauth-tls": {
    category: "broad-safe",
    reason: "local OAuth TLS readiness needed for auth flow reliability",
  },
  "core/doctor/hooks-model": {
    category: "broad-safe",
    reason: "static hooks model validation for configured provider behavior",
  },
  "core/doctor/provider-catalog-projection": {
    category: "broad-safe",
    reason: "static provider catalog projection validation",
  },
  "core/doctor/runtime-tool-schemas": {
    category: "broad-safe",
    reason: "static runtime tool schema validation",
  },
  "core/doctor/bootstrap-size": {
    category: "broad-safe",
    reason: "local bootstrap size check that catches runtime startup risk",
  },
  "core/doctor/shell-completion": {
    category: "broad-safe",
    reason: "local shell completion freshness check with established default behavior",
  },
  "core/doctor/final-config-validation": {
    category: "broad-safe",
    reason: "final static config validation for canonical doctor correctness",
  },
} as const satisfies Record<string, LintDefaultAuditReason>;

const DEFAULT_DISABLED_LINT_AUDIT = {
  "core/doctor/auth-profiles": {
    category: "explicit-only",
    reason: "account-shape dependent and can inspect local credential state",
  },
  "core/doctor/legacy-state": {
    category: "explicit-only",
    reason: "legacy state migration scans historical state and can be broad",
  },
  "core/doctor/legacy-plugin-manifests": {
    category: "explicit-only",
    reason: "legacy plugin cleanup rather than active runtime failure",
  },
  "core/doctor/legacy-plugin-dependencies": {
    category: "explicit-only",
    reason: "legacy plugin dependency cleanup rather than active runtime failure",
  },
  "core/doctor/stale-plugin-runtime-symlinks": {
    category: "explicit-only",
    reason: "stale runtime cleanup that may be normal in older workspaces",
  },
  "core/doctor/configured-plugin-installs": {
    category: "explicit-only",
    reason: "configured plugin state can be environment-specific and noisy",
  },
  "core/doctor/plugin-registry": {
    category: "explicit-only",
    reason: "registry migration signal can be noisy across plugin setups",
  },
  "core/doctor/disk-space": {
    category: "explicit-only",
    reason: "machine-local capacity signal that can be intentionally transient",
  },
  "core/doctor/state-integrity": {
    category: "explicit-only",
    reason: "state-store audit can be broad and support-oriented",
  },
  "core/doctor/session-locks": {
    category: "explicit-only",
    reason: "historical session cleanup rather than current startup failure",
  },
  "core/doctor/session-transcripts": {
    category: "explicit-only",
    reason: "historical transcript cleanup emitted as advisory info",
  },
  "core/doctor/session-snapshots": {
    category: "explicit-only",
    reason: "historical session snapshot cleanup emitted as advisory info",
  },
  "core/doctor/config-audit-scrub": {
    category: "explicit-only",
    reason: "historical audit-log cleanup rather than current config failure",
  },
  "core/doctor/legacy-whatsapp-crontab": {
    category: "explicit-only",
    reason: "shell-backed legacy crontab inspection should be explicit",
  },
  "core/doctor/legacy-cron-store": {
    category: "explicit-only",
    reason: "legacy cron store cleanup rather than current runtime failure",
  },
  "core/doctor/channel-plugin-blockers": {
    category: "explicit-only",
    reason: "channel/plugin readiness depends on selected channel usage",
  },
  "core/doctor/channel-preview-warnings": {
    category: "explicit-only",
    reason: "generic channel preview warnings are channel-specific advisory output",
  },
  "core/doctor/tool-result-cap": {
    category: "explicit-only",
    reason: "policy/config preference check that may be intentionally configured",
  },
  "core/doctor/systemd-linger": {
    category: "explicit-only",
    reason: "host service manager state is platform and deployment specific",
  },
  "core/doctor/workspace-status": {
    category: "explicit-only",
    reason: "workspace diagnostics are support-oriented and can be noisy",
  },
  "core/doctor/skills-readiness": {
    category: "explicit-only",
    reason: "optional skill inventory depends on local tool installs and configured accounts",
  },
  "core/doctor/heartbeat-template": {
    category: "explicit-only",
    reason: "template rewrite readiness is repair-oriented historical state",
  },
  "core/doctor/gateway-health": {
    category: "explicit-only",
    reason: "live gateway/service health can be environment-sensitive",
  },
  "core/doctor/whatsapp-responsiveness": {
    category: "explicit-only",
    reason: "channel-specific live responsiveness should not affect broad lint",
  },
  "core/doctor/memory-search": {
    category: "explicit-only",
    reason: "provider/workspace readiness is support-oriented and account dependent",
  },
  "core/doctor/device-pairing": {
    category: "explicit-only",
    reason: "device pairing state is channel-specific and deployment dependent",
  },
  "core/doctor/gateway-daemon": {
    category: "explicit-only",
    reason: "service daemon state is platform and deployment specific",
  },
  "core/doctor/write-config": {
    category: "explicit-only",
    reason: "write-path blockers are repair-oriented and Nix/install-mode sensitive",
  },
  "core/doctor/workspace-suggestions": {
    category: "explicit-only",
    reason: "advisory workspace suggestions can be left unchanged indefinitely",
  },
} as const satisfies Record<string, LintDefaultAuditReason>;

const EXPECTED_DOCTOR_LINT_CHECK_IDS = [
  "core/doctor/gateway-config",
  "core/doctor/auth-profiles",
  "core/doctor/claude-cli",
  "core/doctor/gateway-auth",
  "core/doctor/command-owner",
  "core/doctor/legacy-state",
  "core/doctor/legacy-plugin-manifests",
  "core/doctor/legacy-plugin-dependencies",
  "core/doctor/stale-plugin-runtime-symlinks",
  "core/doctor/configured-plugin-installs",
  "core/doctor/plugin-registry",
  "core/doctor/ui-protocol-freshness",
  "core/doctor/disk-space",
  "core/doctor/state-integrity",
  "core/doctor/codex-session-routes",
  "core/doctor/session-locks",
  "core/doctor/session-transcripts",
  "core/doctor/session-snapshots",
  "core/doctor/config-audit-scrub",
  "core/doctor/legacy-whatsapp-crontab",
  "core/doctor/legacy-cron-store",
  "core/doctor/sandbox/registry-files",
  "core/doctor/gateway-services/extra",
  "core/doctor/gateway-services/platform-notes",
  "core/doctor/channel-plugin-blockers",
  "core/doctor/channel-preview-warnings",
  "core/doctor/security",
  "core/doctor/browser",
  "core/doctor/browser-clawd-profile-residue",
  "core/doctor/oauth-tls",
  "core/doctor/hooks-model",
  "core/doctor/tool-result-cap",
  "core/doctor/provider-catalog-projection",
  "core/doctor/runtime-tool-schemas",
  "core/doctor/systemd-linger",
  "core/doctor/workspace-status",
  "core/doctor/skills-readiness",
  "core/doctor/bootstrap-size",
  "core/doctor/heartbeat-template",
  "core/doctor/shell-completion",
  "core/doctor/gateway-health",
  "core/doctor/whatsapp-responsiveness",
  "core/doctor/memory-search",
  "core/doctor/device-pairing",
  "core/doctor/gateway-daemon",
  "core/doctor/write-config",
  "core/doctor/workspace-suggestions",
  "core/doctor/final-config-validation",
] as const;

const DEFAULT_ENABLED_LINT_CHECK_IDS = Object.keys(DEFAULT_ENABLED_LINT_AUDIT);
const DEFAULT_DISABLED_LINT_CHECK_IDS = Object.keys(DEFAULT_DISABLED_LINT_AUDIT);

const ctx: HealthCheckContext = {
  mode: "lint",
  runtime: {
    log() {},
    error() {},
    exit() {},
  },
  cfg: {},
};

function isDefaultDisabled(check: HealthCheck): boolean {
  return "defaultEnabled" in check && check.defaultEnabled === false;
}

describe("doctor lint default audit", () => {
  it("classifies every registered Doctor lint check for default selection", async () => {
    const checks = await resolveDoctorContributionHealthChecks();
    const ids = checks.map((check) => check.id);
    const auditedIds = [...DEFAULT_ENABLED_LINT_CHECK_IDS, ...DEFAULT_DISABLED_LINT_CHECK_IDS];

    expect(ids).toEqual(EXPECTED_DOCTOR_LINT_CHECK_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(auditedIds)).toEqual(new Set(ids));
    expect(auditedIds).toHaveLength(ids.length);
  });

  it("keeps advisory or environment-sensitive checks out of default lint", async () => {
    const checks = await resolveDoctorContributionHealthChecks();

    expect(checks.filter(isDefaultDisabled).map((check) => check.id)).toEqual(
      DEFAULT_DISABLED_LINT_CHECK_IDS,
    );
  });

  it("keeps default lint restricted to broad-safe checks while --all runs the full audit set", async () => {
    const checks = (await resolveDoctorContributionHealthChecks()).map((check) =>
      Object.assign({}, check, {
        async detect() {
          return [{ checkId: check.id, severity: "warning" as const, message: "selected" }];
        },
      } satisfies Pick<HealthCheck, "detect">),
    );

    await expect(runDoctorLintChecks(ctx, { checks })).resolves.toMatchObject({
      checksRun: DEFAULT_ENABLED_LINT_CHECK_IDS.length,
      checksSkipped: DEFAULT_DISABLED_LINT_CHECK_IDS.length,
      findings: DEFAULT_ENABLED_LINT_CHECK_IDS.toSorted().map((checkId) =>
        expect.objectContaining({ checkId }),
      ),
    });

    await expect(
      runDoctorLintChecks(ctx, { checks, includeAllChecks: true }),
    ).resolves.toMatchObject({
      checksRun: EXPECTED_DOCTOR_LINT_CHECK_IDS.length,
      checksSkipped: 0,
    });
  });
});
