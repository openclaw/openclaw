import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentBeforeRunHookEvent,
  AgentAfterRunHookEvent,
  HookHandler,
} from "../../internal-hooks.js";

const logPath = path.join(os.homedir(), ".openclaw", "logs", "agent-runs.log");

function appendLog(line: string): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line + "\n", "utf8");
  } catch {
    // best-effort — never crash the agent
  }
}

export const handler: HookHandler<AgentBeforeRunHookEvent | AgentAfterRunHookEvent> = (event) => {
  if (event.type === "agent:beforeRun") {
    appendLog(`${event.timestamp} START sessionKey=${event.sessionKey}`);
  } else if (event.type === "agent:afterRun") {
    appendLog(
      `${event.timestamp} END   sessionKey=${event.sessionKey} duration=${event.durationMs}ms length=${event.responseLength}`,
    );
  }
};
