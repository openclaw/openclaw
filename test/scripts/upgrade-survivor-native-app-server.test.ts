import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { WebSocket } from "ws";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readJsonLines, writeJson } from "./upgrade-survivor-shard.test-support.js";

type Turn = { id: string; status: string; items: unknown[] };
type Thread = {
  id: string;
  parentThreadId?: string;
  source: unknown;
  status: { type: string };
  turns: Turn[];
};
type Result = { thread?: Thread; turn?: Turn; data?: string[]; nextCursor?: string | null };
type Notification = {
  method: string;
  params: {
    threadId?: string;
    turnId?: string;
    turn?: Turn;
    item?: { tool?: string; status?: string };
  };
};

let child: ChildProcessWithoutNullStreams;
let socket: WebSocket;
let phaseFile: string;
let logFile: string;
let sequence = 0;
const pending = new Map<
  number,
  { resolve: (value: Result) => void; reject: (error: Error) => void }
>();
const notifications: Notification[] = [];
const events = new EventEmitter();
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    socket?.terminate();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    cleanup();
  }),
);

function request(method: string, params: object = {}): Promise<Result> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const readMessages = () =>
  readJsonLines<Notification & { direction: string; id: number; message: string }>(logFile);
const fixtureErrors = () => readMessages().filter((entry) => entry.direction === "fixture-error");

const runningId = "native-upgrade-running";
const completeId = "native-upgrade-complete";
async function readThread(threadId: string, includeTurns = true) {
  return (await request("thread/read", { threadId, ...(includeTurns ? { includeTurns } : {}) }))
    .thread!;
}
async function startTurn(threadId: string, text: string) {
  return (await request("turn/start", { threadId, input: [{ type: "text", text }] })).turn!;
}
async function notificationWhere(matches: (entry: Notification) => boolean): Promise<Notification> {
  let observed;
  while (!(observed = notifications.find(matches))) {
    await once(events, "notification");
  }
  return observed;
}

function completed(threadId: string, turnId: string) {
  return notificationWhere((entry) => isCompleted(entry, threadId, turnId));
}

function isCompleted(entry: Notification, threadId: string, turnId: string) {
  return (
    entry.method === "turn/completed" &&
    entry.params.threadId === threadId &&
    entry.params.turn?.id === turnId
  );
}
function isCloseItem(entry: Notification, threadId: string, turnId: string) {
  return (
    entry.params.threadId === threadId &&
    entry.params.turnId === turnId &&
    entry.params.item?.tool === "closeAgent"
  );
}

beforeAll(async () => {
  const root = dirs.make("native-upgrade-protocol-");
  phaseFile = path.join(root, "phase.json");
  logFile = path.join(root, "messages.jsonl");
  const readyFile = path.join(root, "ready.json");
  const driver = path.join(root, "driver.mjs");
  const fixture = pathToFileURL(
    path.resolve("scripts/e2e/lib/upgrade-survivor/native-assignment-app-server.mjs"),
  );
  fs.writeFileSync(
    driver,
    `import fs from "node:fs";
await import(${JSON.stringify(fixture.href)});
process.stdout.write(fs.readFileSync(${JSON.stringify(readyFile)}, "utf8"));`,
  );
  writeJson(phaseFile, { phase: "seed-assignments" });
  child = spawn(
    process.execPath,
    [
      driver,
      ...Object.entries({
        "package-root": process.cwd(),
        "ready-file": readyFile,
        "phase-file": phaseFile,
        "log-file": logFile,
      }).flatMap(([key, value]) => [`--${key}`, value]),
    ],
    { stdio: "pipe" },
  );
  const lines = createInterface({ input: child.stdout });
  const [line] = await Promise.race([
    once(lines, "line"),
    once(child, "exit").then(([code]) => {
      throw new Error(`Native fixture exited before ready: ${code}`);
    }),
  ]);
  lines.close();
  const ready = JSON.parse(line);
  socket = new WebSocket(ready.url);
  socket.on("message", (data) => {
    const message = JSON.parse(rawDataToString(data));
    if (message.method) {
      notifications.push(message);
      events.emit("notification");
      return;
    }
    const response = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      response?.reject(new Error(message.error.message));
    } else {
      response?.resolve(message.result);
    }
  });
  await once(socket, "open");
  await request("initialize", { clientInfo: { name: "native-fixture-regression", version: "1" } });
  socket.send(JSON.stringify({ method: "initialized", params: {} }));
});

it("isolates native seeding, interruption, and closure from incidental parent turns", async () => {
  const parent = (await request("thread/start", { cwd: process.cwd() })).thread!;
  expect(parent.id).toBe("native-upgrade-parent");
  const seeded = await startTurn(parent.id, "NATIVE_UPGRADE_SEED_ASSIGNMENTS");
  await completed(completeId, "native-complete-turn");
  const before = await readThread(parent.id);
  const [running, finished] = await Promise.all([readThread(runningId), readThread(completeId)]);
  expect(running).toMatchObject({
    status: { type: "active" },
    turns: [{ id: "native-running-turn", status: "inProgress" }],
  });
  expect(finished.turns).toMatchObject([
    {
      id: "native-complete-turn",
      status: "completed",
      items: [{ type: "agentMessage", text: "NATIVE_UPGRADE_PENDING_RESULT" }],
    },
  ]);

  const incidental = (await request("thread/start", { cwd: process.cwd() })).thread!;
  expect(incidental.id).not.toBe(parent.id);
  expect(incidental.parentThreadId).toBeUndefined();
  expect(incidental).toMatchObject({ source: "unknown", turns: [] });
  const incidentalTurn = await startTurn(incidental.id, "Unrelated turn while seeding is active.");
  await completed(incidental.id, incidentalTurn.id);
  expect(await readThread(parent.id)).toEqual(before);

  writeJson(phaseFile, { phase: "handoff" });
  await request("turn/interrupt", { threadId: parent.id, turnId: seeded.id });
  await completed(parent.id, seeded.id);
  const interrupted = await readThread(parent.id);
  expect(interrupted.status.type).toBe("idle");
  expect(interrupted.turns.find((turn) => turn.id === seeded.id)?.status).toBe("interrupted");
  expect(interrupted.turns.some((turn) => turn.status === "inProgress")).toBe(false);
  expect(await readThread(runningId)).toEqual(running);
  expect(await readThread(completeId)).toEqual(finished);
  const messages = readMessages();
  expect(fixtureErrors()).toEqual([]);
  const interruptRequest = messages.find(
    (entry) => entry.direction === "request" && entry.method === "turn/interrupt",
  );
  const interruptResponse = messages.findIndex(
    (entry) => entry.direction === "response" && entry.id === interruptRequest!.id,
  );
  const interruptNotification = messages.findIndex(
    (entry) => entry.params && isCompleted(entry, parent.id, seeded.id),
  );
  expect(interruptResponse).toBeGreaterThanOrEqual(0);
  expect(interruptNotification).toBeGreaterThan(interruptResponse);

  for (const phase of ["close-loaded", "close-gone"]) {
    writeJson(phaseFile, { phase });
    const prompt = `Continue the synthetic native upgrade fixture: ${phase}.`;
    const closing = await startTurn(parent.id, prompt);
    await notificationWhere(
      (entry) =>
        entry.method === "item/completed" &&
        isCloseItem(entry, parent.id, closing.id) &&
        entry.params.item?.status === "completed",
    );

    const unrelated = await startTurn(incidental.id, "Unrelated turn without closure.");
    const outcome = await notificationWhere(
      (entry) =>
        isCompleted(entry, incidental.id, unrelated.id) ||
        (entry.method === "item/completed" && isCloseItem(entry, incidental.id, unrelated.id)),
    );
    expect(outcome, `${phase}: incidental turns must not close`).toMatchObject({
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });

    const refused = await startTurn(incidental.id, prompt);
    expect((await completed(incidental.id, refused.id)).params.turn?.status).toBe("failed");
    expect(notifications.some((entry) => isCloseItem(entry, incidental.id, refused.id))).toBe(
      false,
    );

    const waitingParent = await readThread(parent.id);
    expect(waitingParent.turns.find((turn) => turn.id === closing.id)?.status).toBe("inProgress");
    expect((await readThread(runningId, false)).status.type).toBe("active");

    const loaded = await request("thread/loaded/list");
    expect(loaded.nextCursor).toBeNull();
    expect(loaded.data?.filter((id) => id === parent.id)).toHaveLength(1);
    expect(loaded.data?.filter((id) => id === runningId)).toHaveLength(
      phase === "close-loaded" ? 1 : 0,
    );
    expect(loaded.data).not.toContain(completeId);
    expect((await completed(parent.id, closing.id)).params.turn?.status).toBe("completed");
    const confirmed = await readThread(parent.id);
    expect(confirmed.turns.find((turn) => turn.id === closing.id)?.items).toContainEqual(
      expect.objectContaining({ type: "agentMessage", text: "NATIVE_UPGRADE_CLOSE_OBSERVED" }),
    );
  }
  expect(fixtureErrors().map((entry) => entry.message)).toEqual([
    "Native close confirmation is already pending on this connection",
    "Native close confirmation is already pending on this connection",
  ]);
});
