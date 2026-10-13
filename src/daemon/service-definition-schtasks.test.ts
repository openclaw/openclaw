import "./service-definition-backup.mocks.test-support.js";
import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import * as layout from "./schtasks-layout.js";
import * as probe from "./schtasks-state-probe.js";
import { buildScheduledTaskXml } from "./schtasks-xml.js";
import { readScheduledTaskDefinitionMutationCapability } from "./service-audit-schtasks.js";
import { fixture, native } from "./service-definition-backup.test-support.js";

it.each([
  "canonical",
  "retained policy",
  "foreign account",
  "unknown policy",
  "custom launcher",
  "redirected launcher",
  "changed artifact",
  "absent",
  "orphan launcher",
  "unavailable",
])("admits only inspectable Windows definitions: %s", async (kind) => {
  const f = await fixture("win32");
  const script = layout.buildTaskScript(f.command);
  await fs.writeFile(f.sourcePath, script);
  f.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER = "0";
  f.setTask(
    buildScheduledTaskXml({
      taskDescription: "OpenClaw Gateway",
      taskUser: "operator",
      launchPath: f.sourcePath,
    }),
  );
  vi.spyOn(layout, "readScheduledTaskCommand").mockImplementation(async () =>
    kind === "absent" || kind === "orphan launcher" ? null : f.command,
  );
  if (kind === "retained policy") {
    f.setTask(f.task().replace("<ExecutionTimeLimit>PT0S", "<ExecutionTimeLimit>PT1H"));
  }
  if (kind === "foreign account") {
    f.setTask(f.task().replaceAll("<UserId>operator</UserId>", "<UserId>foreign</UserId>"));
    native.identity.mockResolvedValue({
      code: 0,
      stdout: "S-1-5-21-1-2-3-1001\nS-1-5-21-9-9-9-1001",
      stderr: "",
      termination: "exit",
    });
  }
  if (kind === "unknown policy") {
    f.setTask(f.task().replace("<Settings>", "<Settings><Custom>true</Custom>"));
  }
  if (kind === "custom launcher") {
    await fs.appendFile(f.sourcePath, "\r\noperator-command\r\n");
  }
  if (kind === "redirected launcher") {
    const original = `${f.sourcePath}.original`;
    await fs.rename(f.sourcePath, original);
    await fs.symlink(original, f.sourcePath);
  }
  if (kind === "absent" || kind === "orphan launcher") {
    vi.spyOn(probe, "probeScheduledTaskState").mockReturnValue({ status: "missing" });
    if (kind === "absent") {
      await fs.unlink(f.sourcePath);
    }
  }
  if (kind === "unavailable") {
    vi.spyOn(probe, "probeScheduledTaskState").mockReturnValue({
      status: "unknown",
      detail: "inaccessible",
      diagnostic: { kind: "invalid-response" },
    });
  }
  if (kind === "changed artifact") {
    const query = native.task.getMockImplementation()!;
    let changed = false;
    native.task.mockImplementation(async (args: string[]) => {
      const result = await query(args);
      if (!changed && args[0] === "/Query") {
        changed = true;
        const temporary = `${f.sourcePath}.replacement`;
        await fs.writeFile(temporary, script);
        await fs.rename(temporary, f.sourcePath);
      }
      return result;
    });
  }
  native.task.mockClear();
  const allowed = ["canonical", "retained policy", "absent"].includes(kind);
  expect(await readScheduledTaskDefinitionMutationCapability(f.env)).toMatchObject({
    kind: allowed ? "writable" : "unknown",
  });
  expect(native.task.mock.calls.every(([args]) => args[0] === "/Query")).toBe(true);
});
