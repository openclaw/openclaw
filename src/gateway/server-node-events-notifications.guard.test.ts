/**
 * Device notifications are passive context. A phone posts and removes notifications constantly;
 * if any of those events can start an agent turn, every notification becomes a model run billed
 * to the user. This guard fails if the notification handler regains a path that starts a turn.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HANDLER = "src/gateway/server-node-events-notifications.ts";

// Entry points that admit, wake, or dispatch an agent turn. The handler may only queue context.
const TURN_STARTERS = [
  "enqueueSessionEventForHost",
  "consumeSelectedSystemEventEntries",
  "agentCommand",
  "agentCommandFromIngress",
  "requestHeartbeat",
  "runHeartbeat",
  "addChatRun",
  "dispatchInbound",
  "dispatchReply",
];

describe("device notification handler", () => {
  it("never references an API that starts an agent turn", async () => {
    const source = await fs.readFile(path.join(process.cwd(), HANDLER), "utf8");
    const found = TURN_STARTERS.filter((name) => new RegExp(`\\b${name}\\b`).test(source));
    expect(found).toEqual([]);
  });
});
