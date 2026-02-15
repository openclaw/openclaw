import { promises as fs } from "node:fs";
import path from "node:path";
import type { LoopEvent } from "./types.js";

export async function appendEvent(logFile: string, event: LoopEvent): Promise<void> {
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.appendFile(logFile, `${JSON.stringify(event)}\n`, "utf8");
}

export function createEvent(
  goalId: string,
  type: LoopEvent["type"],
  data?: LoopEvent["data"],
): LoopEvent {
  return {
    at: new Date().toISOString(),
    goalId,
    type,
    data,
  };
}
