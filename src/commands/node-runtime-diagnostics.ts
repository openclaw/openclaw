/** Read-only Node findings shared by Doctor and status commands. */
import { nodeRuntimeFailure, nodeRuntimeNote } from "../../node-sqlite.mjs";
import {
  formatUnsupportedNodeVersionMessage,
  parseNodeReleaseVersion,
  SUPPORTED_NODE_VERSIONS,
} from "../../node-version.mjs";
import { isDefaultInstallIdentity } from "../config/paths.js";
import { isNodeRuntime } from "../daemon/runtime-binary.js";
import { resolveNodeRuntimeInfo } from "../daemon/runtime-paths.js";
import { summarizeGatewayServiceLayout } from "../daemon/service-layout.js";
import { resolveGatewayService } from "../daemon/service.js";
import type { HealthCheckContext, HealthFinding } from "../flows/health-checks.js";
import { formatInstallOwnerMessage, readInstallOwner } from "../infra/install-owner.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { detectRuntime } from "../infra/runtime-guard.js";

const CHECK_ID = "core/doctor/node-runtime";

// Upstream lifecycle dates are advisory; SQLite capabilities own admission.
// Compare UTC instants so notes never start before the published effective date.
const NODE_RELEASE_SCHEDULE = [
  { major: 24, maintenance: "2026-10-20", eol: "2028-04-30", lts: true },
  { major: 25, maintenance: "2026-04-01", eol: "2026-06-01", lts: false },
  { major: 26, maintenance: "2027-10-20", eol: "2029-04-30", lts: true },
] as const;

/** Inspect the CLI and recorded service without starting or repairing the service. */
export async function collectNodeRuntimeFindings(
  env: NodeJS.ProcessEnv = process.env,
  mode?: HealthCheckContext["mode"],
): Promise<HealthFinding[]> {
  const findings: HealthFinding[] = [];
  const cliRuntime = await detectRuntime();
  if (cliRuntime.kind === "node" && cliRuntime.sqliteProbe) {
    const failure = nodeRuntimeFailure(cliRuntime.version, cliRuntime.sqliteProbe);
    const message = failure ?? nodeRuntimeNote(cliRuntime.version, cliRuntime.sqliteProbe);
    // Lifecycle advice belongs to standalone Doctor, never status or updater admission.
    const includeLifecycleAdvice =
      mode === "doctor" &&
      !(await import("./doctor/shared/update-phase.js")).isUpdateDoctorLintPass(env);
    const major = parseNodeReleaseVersion(cliRuntime.version)?.major;
    const release =
      includeLifecycleAdvice && !failure
        ? NODE_RELEASE_SCHEDULE.find((entry) => entry.major === major)
        : undefined;
    const now = Date.now();
    const endOfLife = release ? now >= Date.parse(`${release.eol}T00:00:00Z`) : false;
    const installOwner =
      failure || endOfLife
        ? await readInstallOwner(
            await resolveOpenClawPackageRoot({
              moduleUrl: import.meta.url,
              argv1: process.argv[1],
            }),
          )
        : null;
    if (message) {
      findings.push({
        checkId: CHECK_ID,
        severity: failure ? "error" : "info",
        source: "cli",
        message,
        requirement: SUPPORTED_NODE_VERSIONS,
        target: cliRuntime.execPath ?? undefined,
        ...(failure
          ? {
              fixHint: installOwner
                ? formatInstallOwnerMessage(installOwner)
                : formatUnsupportedNodeVersionMessage(cliRuntime.version),
            }
          : {}),
      });
    }
    if (release) {
      const label = release.lts ? `Node ${cliRuntime.version} LTS` : `Node ${cliRuntime.version}`;
      if (endOfLife) {
        findings.push({
          checkId: CHECK_ID,
          severity: "warning",
          source: "cli",
          message: `${label} reached upstream end-of-life on ${release.eol}; it no longer receives security updates.`,
          fixHint: installOwner
            ? formatInstallOwnerMessage(installOwner)
            : "Consider a currently maintained release: https://nodejs.org/en/download",
        });
      } else if (now >= Date.parse(`${release.maintenance}T00:00:00Z`)) {
        findings.push({
          checkId: CHECK_ID,
          severity: "info",
          source: "cli",
          message: `${label} is in upstream maintenance mode (EOL ${release.eol}).`,
        });
      }
    }
  }
  if (!isDefaultInstallIdentity(env)) {
    return findings;
  }
  try {
    const command = await resolveGatewayService().readCommand(env, { timeoutMs: 5_000 });
    const executable = command?.programArguments[0];
    if (executable && isNodeRuntime(executable)) {
      const runtime = await resolveNodeRuntimeInfo(executable, { ...env, ...command.environment });
      if (runtime.status === "probe-failed") {
        throw runtime.error;
      }
      if (runtime.status === "unsupported") {
        const layout = await summarizeGatewayServiceLayout(command);
        const owner = await readInstallOwner(
          layout?.packageRootReal ?? layout?.packageRoot ?? null,
        );
        findings.push({
          checkId: CHECK_ID,
          severity: "warning",
          source: "gateway-service",
          message: `Gateway service Node ${runtime.version ?? "unknown"} is unsupported. Required: ${SUPPORTED_NODE_VERSIONS}.`,
          requirement: SUPPORTED_NODE_VERSIONS,
          fixHint: owner
            ? formatInstallOwnerMessage(owner)
            : [
                ...(runtime.capabilityError ? [runtime.capabilityError] : []),
                formatUnsupportedNodeVersionMessage(runtime.version),
                "After switching Node, refresh a managed Gateway with `openclaw gateway install --force`; for an externally managed service, have its deployment owner update the launcher.",
              ].join("\n"),
        });
      } else if (runtime.note) {
        findings.push({
          checkId: CHECK_ID,
          severity: "info",
          source: "gateway-service",
          message: runtime.note,
          target: executable,
        });
      }
    }
  } catch {
    findings.push({
      checkId: CHECK_ID,
      severity: "warning",
      source: "gateway-service",
      message: "The recorded Gateway service Node runtime could not be inspected.",
      fixHint: "Run `openclaw gateway status --deep` and check access to its recorded executable.",
    });
  }
  return findings;
}
