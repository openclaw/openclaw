import "./isolated-agent.mocks.js";
import path from "node:path";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { ReplyPayload } from "../auto-reply/types.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStoreEntries,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

async function announce(
  payloads: ReplyPayload[],
  options: {
    gateway?: NonNullable<Parameters<typeof makeCfg>[2]>["gateway"];
    entries?: Record<string, SessionEntry>;
    delivery?: { mode: "announce"; channel: "last" | "telegram"; to?: string };
  } = {},
) {
  return withTempCronHome(async (home) => {
    const storePath = path.join(home, ".openclaw", "sessions", "sessions.json");
    const cfg = makeCfg(home, storePath, options.gateway ? { gateway: options.gateway } : {});
    setRuntimeConfigSnapshot(cfg);
    await writeSessionStoreEntries(home, options.entries ?? {});
    const deps = createCliDeps();
    mockAgentPayloads(payloads);
    const result = await runCronIsolatedAgentTurn({
      deliveryAttemptFence: null,
      cfg,
      deps,
      job: {
        ...makeJob({ kind: "agentTurn", message: "do it" }),
        delivery: options.delivery ?? { mode: "announce", channel: "telegram", to: "123" },
      },
      message: "do it",
      sessionKey: "cron:job-1",
      lane: "cron",
    });
    return { result, deps };
  });
}

function reset() {
  setupIsolatedAgentTurnMocks();
  resetSystemEventsForTest();
}
beforeAll(async () => {
  reset();
  await announce([{ text: "warm runtime" }]);
});
beforeEach(reset);

it("adds the exact run-session inspection link only to the final visible payload", async () => {
  const { result, deps } = await announce(
    [
      { text: "first cron update", mediaUrl: "https://example.com/report.png" },
      { text: "final cron summary" },
    ],
    { gateway: { publicOrigin: "https://control.example", controlUi: { basePath: "/console" } } },
  );
  expect(result).toMatchObject({ status: "ok", delivered: true });
  const sessionKey = result.sessionKey;
  if (typeof sessionKey !== "string") {
    throw new Error("expected a cron run session key");
  }
  expect(sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
  const finalText = `final cron summary\nInspect: https://control.example/console/chat/main/${sessionKey.replace(/^agent:main:/, "").replaceAll(":", "/")}`;
  expect(deps.telegram).toHaveBeenNthCalledWith(1, "123", "first cron update", expect.any(Object));
  expect(deps.telegram).toHaveBeenNthCalledWith(2, "123", finalText, expect.any(Object));
  expect(deps.telegram).toHaveBeenCalledTimes(2);
  expect(peekSystemEvents("agent:main:main")).toEqual([]);
  expect(peekSystemEvents("agent:main:global")).toEqual([]);
  expect(peekSystemEventEntries("agent:other:global")).toEqual([]);
});

it("does not turn a silent reply into an inspection-link announcement", async () => {
  const { result, deps } = await announce([{ text: "NO_REPLY" }], {
    gateway: { publicOrigin: "https://control.example" },
  });
  expect(result.status).toBe("ok");
  expect(result.delivered).toBeFalsy();
  expect(deps.telegram).not.toHaveBeenCalled();
});

it("refuses keyless delivery inherited from another conversation's shared main bucket", async () => {
  // #91613: main.lastTo belongs to whichever conversation last wrote the shared bucket.
  const { result, deps } = await announce([{ text: "implicit cron digest" }], {
    delivery: { mode: "announce", channel: "last" },
    entries: {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({ context: { channel: "telegram", to: "123" } }),
      },
    },
  });
  expect(result).toMatchObject({ status: "ok", delivered: false });
  expect(result.error).toBeUndefined();
  expect(result.deliveryState?.status).toBe("not-delivered");
  expect(result.deliveryError).toContain("shared agent-main session bucket");
  expect(deps.telegram).not.toHaveBeenCalled();
  expect(peekSystemEvents("agent:main:main")).toStrictEqual([]);
});
