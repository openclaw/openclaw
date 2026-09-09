/** Read-only Node findings shared by Doctor and status commands. */
import { detectCurrentSqliteCapabilities, nodeRuntimeFailure } from "../../node-sqlite.mjs";
import {
  formatUnsupportedNodeVersionMessage,
  SUPPORTED_NODE_VERSIONS,
} from "../../node-version.mjs";
import { isDefaultInstallIdentity } from "../config/paths.js";
import { isNodeRuntime } from "../daemon/runtime-binary.js";
import { resolveNodeRuntimeInfo } from "../daemon/runtime-paths.js";
import { resolveGatewayService } from "../daemon/service.js";
import type { HealthFinding } from "../flows/health-checks.js";

const CHECK_ID = "core/doctor/node-runtime";

function unsupportedNodeFinding(
  version: string | null,
  source: "cli" | "gateway-service",
  capabilityError?: string,
): HealthFinding {
  const label = source === "cli" ? "CLI" : "Gateway service";
  return {
    checkId: CHECK_ID,
    severity: "warning",
    source,
    message: `${label} Node ${version ?? "unknown"} is unsupported. Required: ${SUPPORTED_NODE_VERSIONS}.`,
    requirement: SUPPORTED_NODE_VERSIONS,
    fixHint: [
      ...(capabilityError ? [capabilityError] : []),
      formatUnsupportedNodeVersionMessage(version),
      ...(source === "gateway-service"
        ? [
            "After switching Node, refresh a managed Gateway with `openclaw gateway install --force`; for an externally managed service, have its deployment owner update the launcher.",
          ]
        : []),
    ].join("\n"),
  };
}

/** Inspect the active CLI and recorded service executable without starting or repairing the service. */
export async function collectNodeRuntimeFindings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HealthFinding[]> {
  const findings: HealthFinding[] = [];
  if (!process.versions.bun) {
    const probe = detectCurrentSqliteCapabilities();
    const failure = nodeRuntimeFailure(process.versions.node, probe);
    if (failure) {
      findings.push(unsupportedNodeFinding(process.versions.node, "cli", failure));
    }
  }
  return [...findings, ...(await collectServiceNodeRuntimeFindings(env))];
}

/** Inspect the recorded service executable without starting or repairing the service. */
export async function collectServiceNodeRuntimeFindings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HealthFinding[]> {
  const findings: HealthFinding[] = [];
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
        findings.push(
          unsupportedNodeFinding(runtime.version, "gateway-service", runtime.capabilityError),
        );
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
