import fs from "node:fs/promises";
import { decodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { ScheduledTaskInspectionError } from "./schtasks-state-probe.js";

export function assertTaskInspectionDeadline(deadline?: number): void {
  if (deadline !== undefined && (!Number.isFinite(deadline) || performance.now() >= deadline)) {
    throw new ScheduledTaskInspectionError({
      status: "unknown",
      detail: "Scheduled Task inspection deadline expired.",
      timeoutMs: 0,
      diagnostic: { kind: "timeout", timeoutMs: 0 },
    });
  }
}

export async function readTaskFile(filePath: string, deadline?: number): Promise<string> {
  assertTaskInspectionDeadline(deadline);
  if (deadline === undefined) {
    return decodeWindowsLauncherScript({ buffer: await fs.readFile(filePath) });
  }
  const controller = new AbortController();
  try {
    const buffer = await awaitWithinDeadline(
      () => fs.readFile(filePath, { signal: controller.signal }),
      deadline,
      () => performance.now(),
    );
    assertTaskInspectionDeadline(deadline);
    if (buffer === ABSOLUTE_DEADLINE_EXPIRED) {
      throw new Error("Scheduled Task file inspection deadline expired.");
    }
    return decodeWindowsLauncherScript({ buffer });
  } finally {
    controller.abort();
  }
}
