import type { IncomingMessage, ServerResponse } from "node:http";
import { writeJson } from "../../../../extensions/qa-lab/api.js";

export async function readTelegramRequest(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
  }
  return text;
}

export function succeedTelegram(res: ServerResponse, result: unknown = true) {
  writeJson(res, 200, { ok: true, result });
}

export function createTelegramUpdateQueue() {
  const pendingUpdates: unknown[] = [];
  const pendingPolls = new Set<ServerResponse>();
  return {
    pendingUpdates,
    pendingPolls,
    enqueue(update: unknown) {
      const poll = pendingPolls.values().next().value;
      if (poll) {
        pendingPolls.delete(poll);
        succeedTelegram(poll, [update]);
      } else {
        pendingUpdates.push(update);
      }
    },
    poll(res: ServerResponse) {
      const update = pendingUpdates.shift();
      if (update) {
        succeedTelegram(res, [update]);
      } else {
        pendingPolls.add(res);
        res.on("close", () => pendingPolls.delete(res));
      }
    },
  };
}

export async function settleTelegramCleanup(...cleanups: Array<() => Promise<void>>) {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    await cleanup().catch((error: unknown) => failures.push(error));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Telegram Gateway cleanup failed");
  }
}
