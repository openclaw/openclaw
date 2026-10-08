import "./service-definition-backup.mocks.test-support.js";
import { expect, it, vi } from "vitest";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { escapeXml } from "../shared/xml.js";
import { buildScheduledTaskXml } from "./schtasks-xml.js";
import { auditScheduledTaskDefinition } from "./service-audit-schtasks.js";
import type { ServiceDefinitionDrift } from "./service-audit-types.js";
import { auditGatewayServiceConfig } from "./service-audit.js";
import { fixture, native } from "./service-definition-backup.test-support.js";

const nativeWindows = process.platform === "win32";
const { execFileUtf8: nativeExecFile } =
  await vi.importActual<typeof import("./exec-file.js")>("./exec-file.js");

// Task Scheduler may omit these default-valued fields when exporting a registered task.
function omitDefaults(xml: string): string {
  return xml.replaceAll(
    /<(Enabled|AllowHardTerminate|AllowStartOnDemand)>true<\/\1>|<(StartWhenAvailable|RunOnlyIfNetworkAvailable|RestartOnIdle|Hidden|RunOnlyIfIdle|WakeToRun)>false<\/\2>|<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>|<RunLevel>LeastPrivilege<\/RunLevel>|<Priority>7<\/Priority>/gu,
    "",
  );
}

it.each(["omitted", "disabled-task", "disabled-trigger", "native-defaults", "missing-trigger"])(
  "audits the effective Windows task enabled state: %s",
  async (kind) => {
    const f = await fixture("win32");
    const xml = buildScheduledTaskXml({
      taskDescription: "OpenClaw Gateway",
      taskUser: kind === "missing-trigger" ? null : "operator",
      launchPath: f.sourcePath,
    });
    const installed =
      kind === "missing-trigger"
        ? xml.replace(/<Triggers>[\s\S]*?<\/Triggers>/u, "")
        : kind === "native-defaults"
          ? xml
              .replace(
                "<LogonTrigger>",
                "<LogonTrigger><Delay>PT0M</Delay><ExecutionTimeLimit>PT72H</ExecutionTimeLimit>",
              )
              .replace(
                "<IdleSettings>",
                "<IdleSettings><Duration>PT10M</Duration><WaitTimeout>PT1H</WaitTimeout>",
              )
          : kind === "omitted"
            ? omitDefaults(xml)
            : xml
                .replace(
                  kind === "disabled-task" ? "<Settings>" : "<LogonTrigger>",
                  (parent) => `${parent}<Enabled>false</Enabled>`,
                )
                .replaceAll("<Enabled>true</Enabled>", "");
    f.setTask(installed);
    const result = await auditGatewayServiceConfig({
      ...f,
      env: kind === "missing-trigger" ? { ...f.env, USERNAME: undefined } : f.env,
      platform: "win32",
    });
    expect(result.definitionDriftError).toBeUndefined();
    expect(result.definitionDrift ?? []).toEqual(
      kind === "omitted" || kind === "native-defaults"
        ? []
        : [
            expect.objectContaining({
              key: kind === "disabled-task" ? "Settings.Enabled" : "Triggers.LogonTrigger.Enabled",
            }),
          ],
    );
  },
);

it.each(["omitted by Windows", "omitted in backup"])(
  "verifies task defaults %s",
  async (direction) => {
    const f = await fixture("win32");
    if (direction === "omitted by Windows") {
      const execute = native.task.getMockImplementation()!;
      native.task.mockImplementation(async (args: string[]) => {
        const result = await execute(args);
        if (args[0] === "/Create") {
          f.setTask(omitDefaults(f.task()));
        }
        return result;
      });
      await expect(f.install()).resolves.toBeUndefined();
      await expect(f.capture.hooks.beforeWrite()).resolves.toBeUndefined();
    } else {
      const expectedXml = omitDefaults(f.task());
      await f.capture.hooks.taskPrepared(expectedXml);
      await expect(f.capture.hooks.taskWritten(expectedXml)).resolves.toBeUndefined();
    }
  },
);

it.each([
  { kind: "legacy-wscript", key: "Actions.Exec.Command", classification: "outdated" },
  { kind: "password", key: "Principals.Principal.LogonType", classification: "unknown-edit" },
  { kind: "arguments", key: "Actions.Exec.Command", classification: "unknown-edit" },
  { kind: "directory", key: "Actions.Exec.WorkingDirectory", classification: "unknown-edit" },
])(
  "preserves operator Windows task policy during $kind audit",
  async ({ kind, key, classification }) => {
    const f = await fixture("win32");
    const hiddenPath = f.sourcePath.replace(/\.cmd$/u, ".vbs");
    let xml = buildScheduledTaskXml({
      taskDescription: "OpenClaw Gateway",
      taskUser: "operator",
      launchPath: kind === "legacy-wscript" ? hiddenPath : f.sourcePath,
      interactive: kind === "legacy-wscript",
    });
    if (kind === "legacy-wscript") {
      xml = xml.replace(
        /<Command>[^<]*<\/Command>/u,
        `<Command>wscript.exe</Command><Arguments>&quot;${escapeXml(hiddenPath)}&quot;</Arguments>`,
      );
    } else if (kind === "password") {
      xml = xml.replace("<LogonType>S4U</LogonType>", "<LogonType>Password</LogonType>");
    } else if (kind === "arguments") {
      xml = xml.replace("</Arguments>", " &amp; operator-private</Arguments>");
    } else {
      xml = xml.replace(
        /<WorkingDirectory>[^<]*<\/WorkingDirectory>/u,
        "<WorkingDirectory>operator-private</WorkingDirectory>",
      );
    }
    f.setTask(xml);
    native.task.mockClear();
    const result = await auditGatewayServiceConfig({ ...f, platform: "win32" });
    expect(result.definitionDriftError).toBeUndefined();
    expect(result.definitionDrift).toContainEqual(
      expect.objectContaining({ kind: classification, key }),
    );
    expect(JSON.stringify(result.definitionDrift)).not.toContain("operator-private");
    expect(f.task()).toBe(xml);
    expect(native.task.mock.calls.every(([args]) => args[0] === "/Query")).toBe(true);
  },
);

it.each([
  { trigger: "FIXTURE\\operator", rejected: false },
  { trigger: "OTHER\\operator", rejected: true },
  { trigger: "unresolved", rejected: true },
  { trigger: "", rejected: true },
])(
  "compares the logon account by SID without broadening its scope: $trigger",
  async ({ trigger, rejected }) => {
    const f = await fixture("win32");
    f.env.USERDOMAIN = "WORKGROUP";
    let taskUser = "operator";
    let installedTrigger = trigger;
    let sid = "S-1-5-21-1-2-3-1001";
    if (nativeWindows && !rejected) {
      const identity = await nativeExecFile(
        getWindowsPowerShellExePath(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $bytes=[Text.Encoding]::UTF8.GetBytes((@{ name=$identity.Name; sid=$identity.User.Value; major=$PSVersionTable.PSVersion.Major } | ConvertTo-Json -Compress)); [Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length)",
        ],
        { timeout: 60_000 },
      );
      expect(identity.code, identity.stderr).toBe(0);
      const account: { name: string; sid: string; major: number } = JSON.parse(identity.stdout);
      expect(account).toMatchObject({
        name: expect.stringContaining("\\"),
        sid: expect.stringMatching(/^S-1-[\d-]+$/u),
        major: 5,
      });
      taskUser = account.name.slice(account.name.lastIndexOf("\\") + 1);
      f.env.USERNAME = taskUser;
      installedTrigger = account.name;
      sid = account.sid;
      native.identity.mockImplementation(nativeExecFile);
    }
    const original = buildScheduledTaskXml({
      taskDescription: "OpenClaw Gateway",
      taskUser,
      launchPath: f.sourcePath,
    });
    f.setTask(
      original
        .replaceAll(/<UserId>[^<]*<\/UserId>/gu, `<UserId>${sid}</UserId>`)
        .replace(
          `<UserId>${sid}</UserId>`,
          installedTrigger ? `<UserId>${escapeXml(installedTrigger)}</UserId>` : "",
        ),
    );
    if (!nativeWindows || rejected) {
      native.identity.mockImplementation(async (_executable, args) => {
        const encoded = /FromBase64String\('([^']+)'\)/u.exec(args.join(" "))?.[1];
        if (!encoded) {
          throw new Error("Missing native account lookup");
        }
        const decoded = Buffer.from(encoded, "base64").toString();
        const names: string[] = decoded.startsWith("[") ? JSON.parse(decoded) : [decoded];
        return {
          code: 0,
          stderr: "",
          termination: "exit",
          stdout: names
            .map((name) =>
              name === "operator" || name === "FIXTURE\\operator"
                ? sid
                : name === "OTHER\\operator"
                  ? "S-1-5-21-9-9-9-1001"
                  : "-",
            )
            .join("\n"),
        };
      });
    }
    const findings: ServiceDefinitionDrift[] = [];
    await auditScheduledTaskDefinition(f.env, findings);
    expect(findings.filter((finding) => finding.kind === "unknown-edit")).toEqual(
      rejected ? [expect.objectContaining({ key: "Triggers.LogonTrigger.UserId" })] : [],
    );
    if (!rejected) {
      const missingTriggerIdentity = original.replace(
        `<UserId>${escapeXml(taskUser)}</UserId>`,
        "",
      );
      const verification: ServiceDefinitionDrift[] = [];
      await auditScheduledTaskDefinition(
        f.env,
        verification,
        undefined,
        undefined,
        missingTriggerIdentity,
      );
      expect(verification).toContainEqual(
        expect.objectContaining({ key: "Triggers.LogonTrigger.UserId", kind: "unknown-edit" }),
      );
    }
  },
);
