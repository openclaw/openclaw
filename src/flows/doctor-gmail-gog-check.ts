import { inspectGog, inspectGogUpgrade, upgradeGog } from "../hooks/gmail-gog.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { resolveCommandProcessSignal } from "../process/exec-spawn.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { HealthCheck } from "./health-checks.js";

const CHECK_ID = "core/doctor/gmail-gog";
const FIX_HINT =
  "Upgrade Gog to v0.48.0 or newer using its installation owner, then restart the Gmail watcher or Gateway. Run `openclaw doctor --repair` to upgrade an eligible, unpinned Homebrew installation.";

export const gmailGogCheck: HealthCheck = {
  id: CHECK_ID,
  kind: "core",
  source: "doctor",
  description: "Configured Gmail watchers use Gog with child-only token environment sources.",
  async detect(ctx) {
    if (!ctx.cfg.hooks?.enabled || !ctx.cfg.hooks.gmail?.account) {
      return [];
    }
    const signal = resolveCommandProcessSignal(getAsyncWorkSignal());
    const inspection = await inspectGog({ env: ctx.env, signal });
    if (inspection.support === "supported") {
      return [];
    }
    return [
      {
        checkId: CHECK_ID,
        severity: "warning",
        category: "fix-now",
        path: "hooks.gmail",
        docsUrl: "https://docs.openclaw.ai/automation/cron-jobs/gmail",
        message: !inspection.executable
          ? "Gmail is configured, but gog could not be found on PATH."
          : inspection.support === "unsupported"
            ? "Selected Gog lacks child-only token environment sources. Gmail watcher tokens remain exposed in process arguments to other local users until Gog is upgraded."
            : "Could not verify Gog support for child-only token environment sources. Gmail may use legacy token arguments, which expose watcher tokens to other local users.",
        fixHint: inspection.executable
          ? FIX_HINT
          : "Install Gog, then rerun Gmail setup or restart the Gateway. Gog v0.48.0 or newer supports child-only token environment sources.",
        details: { executable: inspection.executable, support: inspection.support },
      },
    ];
  },
  async repair(ctx) {
    if (ctx.dryRun) {
      return { changes: [] };
    }
    // The OpenClaw updater's internal Doctor consent does not include third-party packages.
    if (
      isTruthyEnvValue(ctx.env?.OPENCLAW_UPDATE_IN_PROGRESS) ||
      isTruthyEnvValue(process.env.OPENCLAW_UPDATE_IN_PROGRESS)
    ) {
      return {
        status: "skipped",
        reason: "Run `openclaw doctor --repair` separately to review the Gog upgrade.",
        changes: [],
      };
    }
    const signal = resolveCommandProcessSignal(getAsyncWorkSignal());
    signal?.throwIfAborted();
    const inspection = await inspectGog({ env: ctx.env, signal });
    if (inspection.support === "supported") {
      return { changes: [] };
    }
    if (!inspection.executable) {
      return { status: "skipped", reason: "Install Gog using Gmail setup first.", changes: [] };
    }
    const upgrade = await inspectGogUpgrade(inspection, { env: ctx.env, signal });
    if (!upgrade.eligible) {
      return { status: "skipped", reason: upgrade.reason, changes: [] };
    }
    signal?.throwIfAborted();
    const result = await upgradeGog(upgrade, { env: ctx.env, signal });
    if (result.inspection.support !== "supported") {
      return { status: "failed", reason: result.message, changes: [] };
    }
    return {
      changes: [
        "Gog supports child-only token environment sources. Restart the Gmail watcher or Gateway to use them.",
      ],
      effects: [{ kind: "package", action: "upgrade", target: upgrade.formula }],
    };
  },
};
