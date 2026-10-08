import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getWindowsCmdExePath } from "../infra/windows-install-roots.js";
import { escapeXml } from "../shared/xml.js";
import { publishServiceFile } from "./service-stage.js";

// Node hosts need the user's desktop; Gateway services must also start before logon.
export function buildScheduledTaskXml(params: {
  taskDescription: string;
  taskUser: string | null;
  launchPath: string;
  interactive?: boolean;
}): string {
  const description = escapeXml(params.taskDescription);
  const unattended = Boolean(params.taskUser && !params.interactive);
  const command = escapeXml(unattended ? getWindowsCmdExePath() : params.launchPath);
  const action = unattended
    ? `\n      <Arguments>${escapeXml(`/d /s /c ""${params.launchPath}""`)}</Arguments>\n      <WorkingDirectory>${escapeXml(path.dirname(params.launchPath))}</WorkingDirectory>`
    : "";
  const principalLogon = params.taskUser
    ? `\n      <UserId>${escapeXml(params.taskUser)}</UserId>\n      <LogonType>${unattended ? "S4U" : "InteractiveToken"}</LogonType>`
    : "\n      <GroupId>S-1-5-32-545</GroupId>";
  const triggerUser = params.taskUser
    ? `\n      <UserId>${escapeXml(params.taskUser)}</UserId>`
    : "";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${description}</Description>
  </RegistrationInfo>
  <Triggers>${unattended ? "\n    <BootTrigger><Enabled>true</Enabled></BootTrigger>" : ""}
    <LogonTrigger>
      <Enabled>true</Enabled>${triggerUser}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${principalLogon}
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${command}</Command>${action}
    </Exec>
  </Actions>
</Task>`;
}

export function parseScheduledTaskXmlEnabled(output: string): boolean | null {
  const normalized = output.replace(/^\uFEFF/u, "").replaceAll(String.fromCharCode(0), "");
  const settings = /<Settings(?:\s[^>]*)?>([\s\S]*?)<\/Settings>/iu.exec(normalized)?.[1];
  if (settings === undefined) {
    return null;
  }
  const enabled = /<Enabled>\s*(true|false)\s*<\/Enabled>/iu.exec(settings)?.[1];
  // Task Scheduler's schema defaults a missing Settings.Enabled value to true.
  return enabled === undefined ? true : enabled.toLowerCase() === "true";
}

export function setScheduledTaskXmlEnabled(xml: string, enabled: boolean): string {
  if (parseScheduledTaskXmlEnabled(xml) === null) {
    throw new Error("Scheduled Task enabled state could not be inspected.");
  }
  return xml.replace(
    /(<Settings(?:\s[^>]*)?>)([\s\S]*?)(<\/Settings>)/iu,
    (_match, open: string, body: string, close: string) => {
      const value = `<Enabled>${enabled}</Enabled>`;
      const field = /<Enabled>\s*(true|false)\s*<\/Enabled>/iu;
      return `${open}${field.test(body) ? body.replace(field, value) : `${value}${body}`}${close}`;
    },
  );
}

/** Only Settings.Enabled belongs to the native owner's stop/start policy transition. */
function scheduledTaskDefinitionPolicy(xml: string): string {
  if (parseScheduledTaskXmlEnabled(xml) === null) {
    throw new Error("Scheduled Task enabled state could not be inspected.");
  }
  return xml.replace(
    /(<Settings(?:\s[^>]*)?>)([\s\S]*?)(<\/Settings>)/iu,
    (_match, open: string, body: string, close: string) => {
      // Native exports omit default true and place false at their own schema position.
      // Retain the preceding newline; an inline field must not consume the next line.
      const line = /(\r*\n)[ \t]*<Enabled>\s*(true|false)\s*<\/Enabled>[ \t]*\r*\n/iu;
      const remaining = line.test(body)
        ? body.replace(line, "$1")
        : body.replace(/<Enabled>\s*(true|false)\s*<\/Enabled>/iu, "");
      return `${open}${remaining}${close}`;
    },
  );
}

export function matchesScheduledTaskDefinition(
  current: string | null,
  expected: string | null,
  ignoreEnabled = false,
): boolean {
  if (current === expected) {
    return true;
  }
  if (current === null || expected === null) {
    return false;
  }
  const enabled = parseScheduledTaskXmlEnabled(current);
  const expectedEnabled = parseScheduledTaskXmlEnabled(expected);
  return (
    enabled !== null &&
    expectedEnabled !== null &&
    (ignoreEnabled || enabled === expectedEnabled) &&
    scheduledTaskDefinitionPolicy(current) === scheduledTaskDefinitionPolicy(expected)
  );
}

export async function writeTaskXmlTempFile(xml: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-task-xml-"));
  const xmlPath = path.join(tmpDir, "task.xml");
  // Task Scheduler `/XML` expects UTF-16 LE with a BOM on every locale.
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(xml, "utf16le");
  await publishServiceFile({
    filePath: xmlPath,
    contents: Buffer.concat([bom, body]),
    mode: 0o600,
  });
  return xmlPath;
}
