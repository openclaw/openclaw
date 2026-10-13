import "./service-definition-backup.mocks.test-support.js";
import { expect, it } from "vitest";
import { escapeXml } from "../shared/xml.js";
import { buildScheduledTaskXml } from "./schtasks-xml.js";
import { auditGatewayServiceConfig } from "./service-audit.js";
import { fixture, native } from "./service-definition-backup.test-support.js";

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
  { kind: "same SID", account: "WIN-TEST\\operator", sid: "S-1-5-21-1-2-3-1001" },
  { kind: "different SID", account: "WIN-TEST\\other-private", sid: "S-1-5-21-1-2-3-1002" },
  { kind: "unresolvable", account: "WIN-TEST\\unknown-private", sid: undefined },
])("audits a qualified logon account with $kind", async ({ kind, account, sid }) => {
  const f = await fixture("win32");
  const expectedSid = "S-1-5-21-1-2-3-1001";
  const xml = buildScheduledTaskXml({
    taskDescription: "OpenClaw Gateway",
    taskUser: "operator",
    launchPath: f.sourcePath,
  })
    .replace("<UserId>operator</UserId>", `<UserId>${account}</UserId>`)
    .replace("<UserId>operator</UserId>", `<UserId>${expectedSid}</UserId>`);
  f.setTask(xml);
  const identity = {
    code: 0,
    stdout: `${expectedSid}\n`,
    stderr: "",
    termination: "exit" as const,
  };
  native.identity.mockResolvedValueOnce(identity).mockResolvedValue({
    ...identity,
    code: sid ? 0 : 1,
    stdout: sid ? `${sid}\n` : "",
    stderr: sid ? "" : `Cannot resolve ${account}`,
  });
  native.task.mockClear();

  const result = await auditGatewayServiceConfig({
    ...f,
    env: { ...f.env, USERDOMAIN: "WORKGROUP" },
    platform: "win32",
  });

  expect(result.definitionDriftError).toBeUndefined();
  expect(result.definitionDrift ?? []).toEqual(
    kind === "same SID"
      ? []
      : [
          expect.objectContaining({
            kind: "unknown-edit",
            key: "Triggers.LogonTrigger.UserId",
          }),
        ],
  );
  expect(JSON.stringify(result)).not.toContain(account);
  expect(f.task()).toBe(xml);
  expect(native.task.mock.calls.every(([args]) => args[0] === "/Query")).toBe(true);
});

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
