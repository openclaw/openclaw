import { describe, expect, it } from "vitest";
import { getWindowsCmdExePath } from "../infra/windows-install-roots.js";
import { escapeXml } from "../shared/xml.js";
import {
  assertUnattendedLeastPrivilegeTask,
  disableScheduledTaskXmlForFixture,
  normalizeScheduledTaskXmlEnabledForFixture,
  TASK_LOGON_S4U,
  TASK_RUNLEVEL_LEAST_PRIVILEGE,
} from "./schtasks.integration-observation.test-support.js";

function exportedTaskXml(settings: string[] = [], newline = "\r\n") {
  return [
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>",
    "  <Principals><Principal><LogonType>InteractiveToken</LogonType></Principal></Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    ...settings.map((setting) => `    ${setting}`),
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "  </Settings>",
    "  <Actions><Exec><Command>C:\\fixture\\gateway.cmd</Command></Exec></Actions>",
    "</Task>",
  ].join(newline);
}

describe("installed Scheduled Task XML fixtures", () => {
  it.each([undefined, "true"])(
    "disables task and on-demand launch when exported settings are %s",
    (value) => {
      const xml = exportedTaskXml(
        value === undefined
          ? []
          : [`<Enabled>${value}</Enabled>`, `<AllowStartOnDemand>${value}</AllowStartOnDemand>`],
      );
      const disabled = disableScheduledTaskXmlForFixture(xml);
      const settings = disabled.match(/<Settings>([\s\S]*?)<\/Settings>/u)?.[1];
      expect(settings).toContain("<Enabled>false</Enabled>");
      expect(settings).toContain("<AllowStartOnDemand>false</AllowStartOnDemand>");
      expect(settings?.match(/<Enabled>/gu)).toHaveLength(1);
      expect(settings?.match(/<AllowStartOnDemand>/gu)).toHaveLength(1);
      expect(disabled).toContain("<LogonTrigger><Enabled>true</Enabled></LogonTrigger>");
      expect(disabled).toContain("<LogonType>InteractiveToken</LogonType>");
      expect(disabled).toContain("<Command>C:\\fixture\\gateway.cmd</Command>");
      expect(disabled).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    },
  );

  it.each(["\r\r\n"])(
    "compares enabled exports with %j line endings without ignoring other settings",
    (newline) => {
      const enabled = exportedTaskXml(["<AllowStartOnDemand>false</AllowStartOnDemand>"], newline);
      const disabled = exportedTaskXml(
        ["<AllowStartOnDemand>false</AllowStartOnDemand>", "<Enabled>false</Enabled>"],
        newline,
      );
      expect(normalizeScheduledTaskXmlEnabledForFixture(enabled)).toBe(
        normalizeScheduledTaskXmlEnabledForFixture(disabled),
      );
      for (const changed of [
        enabled.replace("gateway.cmd", "other.cmd"),
        enabled.replace("</MultipleInstancesPolicy>", "</MultipleInstancesPolicy>\r"),
        enabled.replace("<Enabled>true</Enabled>", "<Enabled>false</Enabled>"),
        enabled.replace("<AllowStartOnDemand>false", "<AllowStartOnDemand>true"),
      ]) {
        expect(normalizeScheduledTaskXmlEnabledForFixture(changed)).not.toBe(
          normalizeScheduledTaskXmlEnabledForFixture(disabled),
        );
      }
    },
  );
});

describe("schtasks Windows integration principal assertion", () => {
  const scriptPath = "C:\\OpenClaw\\gateway.cmd";
  const taskXml = `<Task><Principals><Principal><LogonType>S4U</LogonType></Principal></Principals><Triggers><BootTrigger/><LogonTrigger/></Triggers><Actions><Exec><Command>${escapeXml(getWindowsCmdExePath())}</Command><Arguments>/d /s /c &quot;&quot;C:\\OpenClaw\\gateway.cmd&quot;&quot;</Arguments><WorkingDirectory>C:\\OpenClaw</WorkingDirectory></Exec></Actions></Task>`;
  it("accepts omitted default run level when COM reports least privilege", () => {
    expect(() =>
      assertUnattendedLeastPrivilegeTask({
        taskXml,
        scriptPath,
        principal: {
          enabled: true,
          lastRunTime: "2026-07-31T00:00:00.0000000Z",
          lastTaskResult: 0,
          logonType: TASK_LOGON_S4U,
          runLevel: TASK_RUNLEVEL_LEAST_PRIVILEGE,
          taskState: 3,
        },
      }),
    ).not.toThrow();
  });

  it("rejects an elevated effective run level", () => {
    expect(() =>
      assertUnattendedLeastPrivilegeTask({
        taskXml: taskXml.replace("</Principal>", "<RunLevel>LeastPrivilege</RunLevel></Principal>"),
        scriptPath,
        principal: {
          enabled: true,
          lastRunTime: "2026-07-31T00:00:00.0000000Z",
          lastTaskResult: 0,
          logonType: TASK_LOGON_S4U,
          runLevel: 1,
          taskState: 3,
        },
      }),
    ).toThrow();
  });
});
