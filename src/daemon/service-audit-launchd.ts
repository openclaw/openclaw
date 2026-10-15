import { resolveGatewayLaunchAgentLabel } from "./constants.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import {
  LAUNCH_AGENT_ENV_WRAPPER_SHELL,
  LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS,
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
import { resolveGatewayStateDir } from "./paths.js";
import { resolveGatewayLogPaths, resolveGatewaySupervisorLogPaths } from "./restart-logs.js";
import {
  isInstallerServiceDescription,
  serviceDefinitionPreserved,
  serviceDefinitionUnknown,
} from "./service-audit-preservation.js";
import type { ServiceConfigIssue, ServiceDefinitionDrift } from "./service-audit-types.js";
import type { GatewayServiceEnv } from "./service-types.js";

function isRetiredLaunchAgentCommand(value: unknown, env: GatewayServiceEnv): boolean {
  if (!Array.isArray(value) || !value.every((arg): arg is string => typeof arg === "string")) {
    return false;
  }
  const label = resolveLaunchAgentLabel(env);
  const wrapperPath = resolveLaunchAgentEnvWrapperPath(env, label);
  const wrapperIndex = value[0] === LAUNCH_AGENT_ENV_WRAPPER_SHELL ? 1 : 0;
  const wrapped = value[wrapperIndex] === wrapperPath;
  if (wrapped && value[wrapperIndex + 1] !== resolveLaunchAgentEnvFilePath(env, label)) {
    return false;
  }
  const args = wrapped ? value.slice(wrapperIndex + 2) : value;
  if (!/\/(node|bun)$/u.test(args[0] ?? "")) {
    return false;
  }
  // Recognize the released command shape, not arbitrary runtime or Gateway flags.
  let entry = 1;
  if (/^--max-old-space-size=\d+$/u.test(args[entry] ?? "") || args[entry] === "--no-install") {
    entry++;
  }
  if (!/^\/.*\/(?:index|entry)\.(?:cjs|mjs|js)$/u.test(args[entry] ?? "")) {
    return false;
  }
  const command = args.slice(entry + 1);
  return (
    command[0] === "gateway" &&
    (command.length === 1 ||
      (command[1] === "--port" &&
        /^\d+$/u.test(command[2] ?? "") &&
        (command.length === 3 || (command.length === 4 && command[3] === "--allow-unconfigured"))))
  );
}

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
  const { stdoutPath } = resolveGatewaySupervisorLogPaths(env);
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
  // Stable releases used 60s/1s throttles and state-directory logs.
  // Installation age alone does not attribute arbitrary explicit values to the installer.
  const released: Record<string, readonly (string | number)[]> = {
    ThrottleInterval: [60, 1],
    StandardOutPath: [legacyLogs.stdoutPath],
    StandardErrorPath: [legacyLogs.stderrPath, "/dev/null"],
  };
  // A 20s value alone is ambiguous. Even an installer comment can survive an
  // operator edit, so require the rest of the released template before migrating.
  const retiredTemplate =
    installed.Label === resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE) &&
    isInstallerServiceDescription(installed.Comment, env) &&
    isRetiredLaunchAgentCommand(installed.ProgramArguments, env) &&
    (installed.WorkingDirectory === undefined ||
      installed.WorkingDirectory === resolveGatewayStateDir(env)) &&
    Object.keys(installed).every((key) => Object.hasOwn(expected, key) || preserved.has(key)) &&
    Object.entries(expected).every(
      ([key, value]) =>
        key === "ExitTimeOut" ||
        installed[key] === value ||
        released[key]?.some((legacy) => installed[key] === legacy),
    );
  if (retiredTemplate) {
    released.ExitTimeOut = [20];
  }
  const customizedTimeout = installed.ExitTimeOut === 20 && !retiredTemplate;
  const timeoutMessage = customizedTimeout
    ? `Stop timeout 20 s is below the ${LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS} s drain budget; not changed because the definition is customized.`
    : `ExitTimeOut=${LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS} or longer is required for the Gateway drain and final cleanup; the loaded launchd job may enforce a shorter deadline.`;
  const exitTimeout = installed.ExitTimeOut ?? 20;
  if (
    typeof exitTimeout === "number" &&
    exitTimeout > 0 &&
    exitTimeout < LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS
  ) {
    issues.push({
      code: "launchd-stop-timeout",
      message: timeoutMessage,
      detail: `${sourcePath}: ${exitTimeout}s`,
      level: "recommended",
    });
  }
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
      const finding = serviceDefinitionPreserved(key, sourcePath);
      if (key === "ExitTimeOut" && customizedTimeout) {
        finding.message = timeoutMessage;
      }
      findings.push(finding);
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
