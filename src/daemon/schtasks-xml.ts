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
