import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export type HeartbeatEvent = {
  type: "heartbeat";
  ts: number; // epoch ms
  status: "sent" | "ok-empty" | "ok-token" | "skipped" | "failed";
  to?: string;
  preview?: string;
  durationMs?: number;
  hasMedia?: boolean;
  reason?: string;
};

const EVENT_FILENAME = "heartbeat-events.jsonl";
const STATE_FILENAME = "heartbeat-state.json";

function baseDir() {
  const dir = path.join(os.homedir(), ".clawdis");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function heartbeatEventsPath() {
  return path.join(baseDir(), EVENT_FILENAME);
}

export function heartbeatStatePath() {
  return path.join(baseDir(), STATE_FILENAME);
}

export function writeHeartbeatEvent(evt: HeartbeatEvent) {
  const line = JSON.stringify(evt);
  fs.appendFileSync(heartbeatEventsPath(), `${line}\n`, { encoding: "utf8" });
  fs.writeFileSync(heartbeatStatePath(), line, { encoding: "utf8" });
}

export function readLatestHeartbeat(): HeartbeatEvent | null {
  try {
    const txt = fs.readFileSync(heartbeatStatePath(), "utf8");
    return JSON.parse(txt) as HeartbeatEvent;
  } catch {
    return null;
  }
}

// Tail the events file and invoke the callback for every new parsed event.
export function tailHeartbeatEvents(onEvent: (evt: HeartbeatEvent) => void) {
  const file = heartbeatEventsPath();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "", { encoding: "utf8" });
  }

  const stream = fs.createReadStream(file, { encoding: "utf8", flags: "a+" });
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as HeartbeatEvent;
      if (parsed?.type === "heartbeat") onEvent(parsed);
    } catch {
      // ignore malformed
    }
  });

  return () => {
    rl.close();
    stream.close();
  };
}
