import { describe, expect, it } from "vitest";
import {
  disableScheduledTaskXmlForFixture,
  normalizeScheduledTaskXmlEnabledForFixture,
} from "./schtasks.integration-observation.test-support.js";

function exportedTaskXml(settings: string[] = []) {
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
  ].join("\r\n");
}

describe("installed Scheduled Task XML fixtures", () => {
  it.each([undefined, "true", "false"])(
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

  it("compares an enabled export with its default omitted without ignoring other settings", () => {
    const enabled = exportedTaskXml(["<AllowStartOnDemand>false</AllowStartOnDemand>"]);
    const disabled = exportedTaskXml([
      "<AllowStartOnDemand>false</AllowStartOnDemand>",
      "<Enabled>false</Enabled>",
    ]);
    expect(normalizeScheduledTaskXmlEnabledForFixture(enabled)).toBe(
      normalizeScheduledTaskXmlEnabledForFixture(disabled),
    );
    for (const changed of [
      enabled.replace("gateway.cmd", "other.cmd"),
      enabled.replace("<Enabled>true</Enabled>", "<Enabled>false</Enabled>"),
      enabled.replace("<AllowStartOnDemand>false", "<AllowStartOnDemand>true"),
    ]) {
      expect(normalizeScheduledTaskXmlEnabledForFixture(changed)).not.toBe(
        normalizeScheduledTaskXmlEnabledForFixture(disabled),
      );
    }
  });
});
