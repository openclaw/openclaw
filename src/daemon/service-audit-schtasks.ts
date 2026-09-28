import fs from "node:fs/promises";
import path from "node:path";
import { DOMParser } from "linkedom";
import { hasErrnoCode } from "../infra/errno.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { decodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import { execFileUtf8 } from "./exec-file.js";
import { execSchtasks } from "./schtasks-exec.js";
import {
  buildScheduledTaskXml,
  buildTaskScript,
  buildHiddenLauncherScript,
  readScheduledTaskCommand,
  resolveTaskName,
  resolveTaskScriptPath,
  resolveTaskLauncherScriptPath,
} from "./schtasks-layout.js";
import {
  isInstallerServiceDescription,
  serviceDefinitionPreserved,
} from "./service-audit-preservation.js";
import type {
  GatewayServiceExpectedCommand,
  ServiceDefinitionDrift,
} from "./service-audit-types.js";
import { resolveTaskUser } from "./service-process-env.js";
import type { GatewayServiceEnv } from "./service-types.js";

function elementKey(node: ReturnType<DOMParser["parseFromString"]>["documentElement"]): string {
  return !node.parentElement || node.parentElement.tagName === "Task"
    ? node.tagName
    : `${elementKey(node.parentElement)}.${node.tagName}`;
}

export async function auditScheduledTaskDefinition(
  env: GatewayServiceEnv,
  findings: ServiceDefinitionDrift[],
  timeoutMs?: number,
  expectedCommand?: GatewayServiceExpectedCommand,
  expectedXml?: string,
): Promise<string> {
  const sourcePath = resolveTaskScriptPath(env);
  const hiddenPath = resolveTaskLauncherScriptPath(
    { OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" },
    sourcePath,
  );
  const query = await execSchtasks(["/Query", "/TN", resolveTaskName(env), "/XML"]);
  if (query.code !== 0) {
    throw new Error("Scheduled Task definition could not be read.");
  }
  const parser = new DOMParser();
  const xml = query.stdout.replace(/^\uFEFF/u, "").replaceAll(String.fromCharCode(0), "");
  const installed = parser.parseFromString(xml, "text/xml");
  if (installed.documentElement?.tagName !== "Task" || installed.doctype) {
    throw new Error("Scheduled Task definition could not be decoded.");
  }
  const expected = parser.parseFromString(
    expectedXml ??
      buildScheduledTaskXml({
        taskDescription: "",
        taskUser: resolveTaskUser(env),
        launchPath: sourcePath,
      }),
    "text/xml",
  );
  if (expected.documentElement?.tagName !== "Task" || expected.doctype) {
    throw new Error("Expected Scheduled Task definition could not be decoded.");
  }
  const taskUser = expected.querySelector("Principals > Principal > UserId")?.textContent;
  const samePath = (left: string, right: string) =>
    path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
  const unknown = (key: string, reason: string) =>
    findings.push({
      kind: "unknown-edit",
      key,
      reason,
      sourcePath,
      message: `Scheduled Task ${key} contains an unrecognized setting.`,
    });
  const outdated = (key: string, current: string | null, value: string) =>
    findings.push({
      kind: "outdated",
      key,
      current,
      expected: value,
      sourcePath,
      message: `Scheduled Task ${key} differs from the installer value ${value}.`,
    });
  // Task Scheduler exports the installer's account as a SID rather than a name.
  let userSid: string | undefined;
  if (
    taskUser &&
    [...installed.querySelectorAll("Principal > UserId, LogonTrigger > UserId")].some(
      (node) => node.textContent.toLowerCase() !== taskUser.toLowerCase(),
    )
  ) {
    const encoded = Buffer.from(taskUser).toString("base64");
    const identity = await execFileUtf8(
      getWindowsPowerShellExePath(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; $name=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); ([Security.Principal.NTAccount]$name).Translate([Security.Principal.SecurityIdentifier]).Value`,
      ],
      { timeout: timeoutMs ?? 15_000 },
    );
    if (identity.code === 0 && /^S-1-[\d-]+$/u.test(identity.stdout.trim())) {
      userSid = identity.stdout.trim();
    }
  }
  const nativeDefaults: Record<string, string> = {
    // https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema
    // DeleteExpiredTaskAfter is excluded: omission disables deletion, unlike explicit PT0S.
    "Principals.Principal.RunLevel": "LeastPrivilege",
    "Triggers.LogonTrigger.Enabled": "true",
    "Triggers.LogonTrigger.ExecutionTimeLimit": "PT72H",
    "Triggers.LogonTrigger.Delay": "PT0M",
    "Settings.AllowStartOnDemand": "true",
    "Settings.MultipleInstancesPolicy": "IgnoreNew",
    "Settings.DisallowStartIfOnBatteries": "true",
    "Settings.StopIfGoingOnBatteries": "true",
    "Settings.AllowHardTerminate": "true",
    "Settings.StartWhenAvailable": "false",
    "Settings.RunOnlyIfNetworkAvailable": "false",
    "Settings.WakeToRun": "false",
    "Settings.Enabled": "true",
    "Settings.Hidden": "false",
    "Settings.ExecutionTimeLimit": "PT72H",
    "Settings.Priority": "7",
    "Settings.RunOnlyIfIdle": "false",
    "Settings.IdleSettings.Duration": "PT10M",
    "Settings.IdleSettings.WaitTimeout": "PT1H",
    "Settings.IdleSettings.StopOnIdleEnd": "true",
    "Settings.IdleSettings.RestartOnIdle": "false",
    "Settings.UseUnifiedSchedulingEngine": "false",
    "Settings.DisallowStartOnRemoteAppSession": "false",
    "Settings.Volatile": "false",
  };
  const released: Record<string, string> = {
    "Settings.DisallowStartIfOnBatteries": "true",
    "Settings.StopIfGoingOnBatteries": "true",
    // Pre-XML installers used /Create defaults for these settings.
    "Settings.ExecutionTimeLimit": "PT72H",
    "Settings.IdleSettings.StopOnIdleEnd": "true",
    "Principals.Principal.LogonType": "S4U",
    "Settings.RestartOnFailure.Count": "0",
    "Settings.RestartOnFailure.Interval": "PT0S",
  };
  const preserved =
    /^(?:RegistrationInfo\.(?:Description|Date|Author|URI)|Actions\.Exec\.Command)$/u;
  const seen = new Set<string>();
  for (const node of [installed.documentElement, ...installed.querySelectorAll("Task *")]) {
    const key = elementKey(node);
    const canonical =
      key === "Task"
        ? expected.documentElement
        : expected.querySelector(key.replaceAll(".", " > "));
    if (seen.has(key)) {
      unknown(key, "Duplicate native definition field.");
    }
    seen.add(key);
    for (const attribute of new Set([
      ...node.getAttributeNames(),
      ...(canonical?.getAttributeNames() ?? []),
    ])) {
      if (
        !(key === "Task" && attribute === "version") &&
        node.getAttribute(attribute) !== canonical?.getAttribute(attribute)
      ) {
        unknown(`${key}.@${attribute}`, "Native definition attribute differs from the installer.");
      }
    }
    const current = node.textContent;
    let nativeRegistration = false;
    if (
      (expectedCommand || expectedXml) &&
      key.startsWith("RegistrationInfo.") &&
      preserved.test(key)
    ) {
      const recognized = key.endsWith("Description")
        ? isInstallerServiceDescription(current, env)
        : key.endsWith("Date")
          ? /^\d{4}-\d\d-\d\dT[\d:.+-]+Z?$/u.test(current)
          : key.endsWith("Author")
            ? current.toLowerCase() === taskUser?.toLowerCase() || current === userSid
            : current === `\\${resolveTaskName(env)}`;
      nativeRegistration = key !== "RegistrationInfo.Description" && recognized;
      if (!expectedXml && !recognized) {
        unknown(key, "The installer would replace custom service metadata.");
      }
    }
    if (
      (!expectedXml && preserved.test(key)) ||
      (expectedXml &&
        (nativeRegistration ||
          key === "Settings.Enabled" ||
          (key === "Actions.Exec.Command" &&
            canonical &&
            samePath(current, canonical.textContent)))) ||
      (node.tagName === "UserId" &&
        canonical &&
        taskUser &&
        (current.toLowerCase() === taskUser.toLowerCase() || current === userSid))
    ) {
      continue;
    }
    if (
      (!canonical && nativeDefaults[key] === current) ||
      (canonical && (node.children.length || current === canonical.textContent))
    ) {
      continue;
    }
    if (canonical && released[key] === current) {
      outdated(key, current, canonical.textContent);
    } else if (
      !expectedXml &&
      canonical &&
      ((key.startsWith("Settings.") && key !== "Settings.Enabled") ||
        key === "Triggers.LogonTrigger.Enabled")
    ) {
      findings.push(serviceDefinitionPreserved(key, sourcePath));
    } else {
      unknown(key, "The key or value is not a recognized installer setting.");
    }
  }
  for (const node of expected.querySelectorAll("Task *")) {
    const key = elementKey(node);
    if (
      seen.has(key) ||
      node.children.length ||
      (!expectedXml && preserved.test(key)) ||
      (expectedXml && key === "Settings.Enabled") ||
      // Default leaf values do not imply that a missing trigger or principal exists.
      (nativeDefaults[key] === node.textContent &&
        (key.startsWith("Settings.") ||
          installed.querySelector(elementKey(node.parentElement!).replaceAll(".", " > "))))
    ) {
      continue;
    }
    if (key.startsWith("Principals.") || key.endsWith("UserId")) {
      unknown(key, "Installer identity field is missing.");
    } else {
      outdated(key, null, node.textContent);
    }
  }
  const launcher = installed.querySelector("Actions > Exec > Command")?.textContent;
  if (
    !expectedXml &&
    (!launcher || ![sourcePath, hiddenPath].some((candidate) => samePath(candidate, launcher)))
  ) {
    unknown("Actions.Exec.Command", "Native task points at an unrecognized launcher.");
  }
  if (expectedCommand) {
    const command = await readScheduledTaskCommand(env, { requireEffective: true, timeoutMs });
    const normalize = (text: string) =>
      text
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => {
          const comment = /^(?:rem |')(.+)$/iu.exec(line)?.[1];
          return (
            line &&
            !(comment && isInstallerServiceDescription(comment.trim(), env)) &&
            line !== 'set "OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER=1"'
          );
        })
        .join("\n")
        .replace(/(?: --task-supervisor)?(?:\s*<\s*NUL)?$/iu, "");
    const read = async (file: string) =>
      decodeWindowsLauncherScript({ buffer: await fs.readFile(file) });
    if (!command || normalize(await read(sourcePath)) !== normalize(buildTaskScript(command))) {
      unknown("TaskScript", "The generated task script contains unrecognized behavior.");
    }
    const hiddenSelected = Boolean(launcher && samePath(launcher, hiddenPath));
    if (
      hiddenSelected ||
      resolveTaskLauncherScriptPath({ ...env, ...expectedCommand.environment }, sourcePath) !==
        sourcePath
    ) {
      const legacy = `CreateObject("WScript.Shell").Run """${sourcePath.replaceAll('"', '""')}""", 0, False`;
      // 2026.9.3 emitted this waiting launcher before the supervisor environment marker.
      const releasedWaiting = `WScript.Quit CreateObject("WScript.Shell").Run("""${sourcePath.replaceAll('"', '""')}""", 0, True)`;
      const generated = buildHiddenLauncherScript({
        scriptPath: sourcePath,
        taskSupervisor: command?.environment?.OPENCLAW_SERVICE_KIND === "gateway",
      });
      const installedLauncher = await read(hiddenPath).catch((error: unknown) => {
        if (!hiddenSelected && hasErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (
        installedLauncher !== undefined &&
        ![legacy, releasedWaiting, generated].some(
          (candidate) => normalize(candidate) === normalize(installedLauncher),
        )
      ) {
        unknown("TaskLauncher", "The generated task launcher contains unrecognized behavior.");
      }
    }
  }
  return xml;
}
