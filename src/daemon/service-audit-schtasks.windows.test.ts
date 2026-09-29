import "./service-definition-backup.mocks.test-support.js";
import { expect, it } from "vitest";
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

it("verifies a refreshed restored task after Windows omits default fields", async () => {
  const f = await fixture("win32");
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
});

it("verifies restored XML when Windows exports defaults omitted in the backup", async () => {
  const f = await fixture("win32");
  const expectedXml = omitDefaults(f.task());
  await f.capture.hooks.taskPrepared(expectedXml);
  await expect(f.capture.hooks.taskWritten(expectedXml)).resolves.toBeUndefined();
});
