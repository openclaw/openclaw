/** Read-only Node findings shared by Doctor and status commands. */
import { nodeRuntimeFailure } from "../../node-sqlite.mjs";
import {
  formatNodeSecurityWarning,
  formatUnsupportedNodeVersionMessage,
  SUPPORTED_NODE_VERSIONS,
} from "../../node-version.mjs";
import { isDefaultInstallIdentity } from "../config/paths.js";
import { isNodeRuntime } from "../daemon/runtime-binary.js";
import { resolveNodeRuntimeInfo } from "../daemon/runtime-paths.js";
import { summarizeGatewayServiceLayout } from "../daemon/service-layout.js";
import { resolveGatewayService } from "../daemon/service.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatInstallOwnerMessage, readInstallOwner } from "../infra/install-owner.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { detectRuntime } from "../infra/runtime-guard.js";

const CHECK_ID = "core/doctor/node-runtime";

/** Inspect the CLI and recorded service without starting or repairing the service. */
export async function collectNodeRuntimeFindings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HealthFinding[]> {
  const findings: HealthFinding[] = [];
  const cliRuntime = await detectRuntime();
  if (cliRuntime.kind === "node" && cliRuntime.sqliteProbe) {
    const failure = nodeRuntimeFailure(cliRuntime.version, cliRuntime.sqliteProbe);
    const securityWarning = failure ? null : formatNodeSecurityWarning(cliRuntime.version);
    if (failure || securityWarning) {
      const installOwner = await readInstallOwner(
        await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url, argv1: process.argv[1] }),
      );
      findings.push({
        checkId: CHECK_ID,
        severity: failure ? "error" : "warning",
        source: "cli",
        message: failure ?? `SECURITY WARNING: ${securityWarning}`,
        requirement: failure ? SUPPORTED_NODE_VERSIONS : "recommended Node security patches",
        target: cliRuntime.execPath ?? undefined,
        fixHint: installOwner
          ? formatInstallOwnerMessage(installOwner)
          : failure
            ? formatUnsupportedNodeVersionMessage(cliRuntime.version)
            : "Upgrade the Node.js runtime to the recommended security patch level. Compatible older Node remains usable.",
      });
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
      const securityWarning =
        runtime.status === "supported" ? formatNodeSecurityWarning(runtime.version) : null;
      if (runtime.status === "unsupported" || securityWarning) {
        const layout = await summarizeGatewayServiceLayout(command);
        const owner = await readInstallOwner(
          layout?.packageRootReal ?? layout?.packageRoot ?? null,
        );
        findings.push({
          checkId: CHECK_ID,
          severity: "warning",
          source: "gateway-service",
          message: securityWarning
            ? `SECURITY WARNING: Recorded Gateway service runtime: ${securityWarning}`
            : `Gateway service Node ${runtime.version ?? "unknown"} is unsupported. Required: ${SUPPORTED_NODE_VERSIONS}.`,
          requirement: securityWarning
            ? "recommended Node security patches"
            : SUPPORTED_NODE_VERSIONS,
          fixHint: owner
            ? formatInstallOwnerMessage(owner)
            : securityWarning
              ? "Upgrade the service Node.js runtime, then refresh the managed Gateway runtime selection and restart it. Compatible older Node remains usable."
              : [
                  ...(runtime.capabilityError ? [runtime.capabilityError] : []),
                  formatUnsupportedNodeVersionMessage(runtime.version),
                  "After switching Node, refresh a managed Gateway with `openclaw gateway install --force`; for an externally managed service, have its deployment owner update the launcher.",
                ].join("\n"),
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
