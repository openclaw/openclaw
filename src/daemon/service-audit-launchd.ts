import { resolveLaunchAgentLabel } from "./launchd-label.js";
import {
  LAUNCH_AGENT_ENV_WRAPPER_SHELL,
  LAUNCH_AGENT_POLICY,
  decodeLaunchdPlistMetadata,
} from "./launchd-plist.js";
import {
  buildLaunchAgentEnvironmentWrapper,
  isGeneratedLaunchAgentEnvironmentWrapper,
  readExistingLaunchAgentPlist,
  resolveLaunchAgentEnvFilePath,
  resolveLaunchAgentEnvWrapperPath,
  resolveLaunchAgentPlistPath,
} from "./launchd-service-files.js";
import { resolveGatewayLogPaths, resolveGatewaySupervisorLogPaths } from "./restart-logs.js";
import {
  isInstallerServiceDescription,
  serviceDefinitionPreserved,
  serviceDefinitionUnknown,
} from "./service-audit-preservation.js";
import type { ServiceConfigIssue, ServiceDefinitionDrift } from "./service-audit-types.js";
import type { GatewayServiceEnv } from "./service-types.js";

/** Native decoding keeps XML and binary plists on the same read-only audit path. */
export async function auditLaunchdDefinition(
  env: GatewayServiceEnv,
  issues: ServiceConfigIssue[],
  findings: ServiceDefinitionDrift[],
  timeoutMs?: number,
  inspectRewrite = false,
): Promise<void> {
  const sourcePath = resolveLaunchAgentPlistPath(env);
  const content = (await readExistingLaunchAgentPlist(sourcePath))?.contents ?? null;
  if (content === null) {
    return;
  }
  // Keep existing repair predicates while deriving both outputs from one capture.
  const text = content.toString("utf8");
  for (const [key, code] of [
    ["RunAtLoad", "launchd-run-at-load"],
    ["KeepAlive", "launchd-keep-alive"],
  ] as const) {
    if (!new RegExp(`<key>${key}</key>\\s*<true\\s*/>`, "i").test(text)) {
      issues.push({
        code,
        message: `LaunchAgent is missing ${key}=true`,
        detail: sourcePath,
        level: "recommended",
      });
    }
  }
  const installed = await decodeLaunchdPlistMetadata(content, timeoutMs);
  if (!installed) {
    throw new Error("LaunchAgent definition could not be decoded.");
  }
  const wrapperPath = resolveLaunchAgentEnvWrapperPath(env, resolveLaunchAgentLabel(env));
  const args = installed.ProgramArguments;
  const wrapperIndex = Array.isArray(args) && args[0] === LAUNCH_AGENT_ENV_WRAPPER_SHELL ? 1 : 0;
  if (
    Array.isArray(args) &&
    args[wrapperIndex] === wrapperPath &&
    args[wrapperIndex + 1] !== resolveLaunchAgentEnvFilePath(env, resolveLaunchAgentLabel(env))
  ) {
    issues.push({
      code: "launchd-env-file-argument",
      message:
        "LaunchAgent environment-file argument is missing or invalid. Run openclaw gateway install --force to repair the service.",
      detail: sourcePath,
      level: "recommended",
    });
  }
  const wrapper = (await readExistingLaunchAgentPlist(wrapperPath))?.contents.toString("utf8");
  if (
    wrapper !== undefined &&
    isGeneratedLaunchAgentEnvironmentWrapper(wrapper) &&
    wrapper !== buildLaunchAgentEnvironmentWrapper()
  ) {
    issues.push({
      code: "launchd-env-wrapper-outdated",
      message: "LaunchAgent environment wrapper needs validation; reinstall the Gateway service.",
      level: "recommended",
    });
    findings.push({
      kind: "outdated",
      key: "EnvironmentWrapper",
      current: "legacy",
      expected: "validated",
      sourcePath: wrapperPath,
      message: "LaunchAgent environment wrapper lacks environment-file validation.",
    });
  }
  if (inspectRewrite) {
    if (!isInstallerServiceDescription(installed.Comment, env)) {
      findings.push(
        serviceDefinitionUnknown(
          "Comment",
          "The installer would replace custom service metadata.",
          sourcePath,
        ),
      );
    }
    if (wrapper !== undefined && !isGeneratedLaunchAgentEnvironmentWrapper(wrapper)) {
      findings.push(
        serviceDefinitionUnknown(
          "EnvironmentWrapper",
          "The generated wrapper contains unrecognized behavior.",
          wrapperPath,
        ),
      );
    }
  }
  const { stdoutPath } = resolveGatewaySupervisorLogPaths(env, { platform: "darwin" });
  const expected: Record<string, string | number | boolean> = {
    ...LAUNCH_AGENT_POLICY,
    Label: resolveLaunchAgentLabel(env),
    StandardOutPath: stdoutPath,
    StandardErrorPath: stdoutPath,
  };
  const preserved = new Set([
    "ProgramArguments",
    "WorkingDirectory",
    "EnvironmentVariables",
    "Comment",
  ]);
  const legacyLogs = resolveGatewayLogPaths(env);
  // Stable releases used 60s/1s throttles, state-directory logs, and discarded stderr.
  // Installation age alone does not attribute arbitrary explicit values to the installer.
  const released: Record<string, readonly (string | number)[]> = {
    ThrottleInterval: [60, 1],
    StandardOutPath: [legacyLogs.stdoutPath],
    StandardErrorPath: [legacyLogs.stderrPath, "/dev/null"],
  };
  for (const key of new Set([...Object.keys(installed), ...Object.keys(expected)])) {
    if (preserved.has(key) || installed[key] === expected[key]) {
      continue;
    }
    const current = installed[key];
    const value = expected[key];
    if (
      value !== undefined &&
      key !== "Label" &&
      (current === undefined ||
        ((typeof current === "string" || typeof current === "number") &&
          released[key]?.includes(current)))
    ) {
      findings.push({
        kind: "outdated",
        key,
        current: current ?? null,
        expected: value,
        sourcePath,
        message: `LaunchAgent ${key} differs from the installer value ${String(value)}.`,
      });
    } else if (value !== undefined && key !== "Label") {
      findings.push(serviceDefinitionPreserved(key, sourcePath));
    } else {
      findings.push({
        kind: "unknown-edit",
        key,
        sourcePath,
        reason: "The key or value is not a recognized installer setting.",
        message: `LaunchAgent ${key} contains an unrecognized setting.`,
      });
    }
  }
}
