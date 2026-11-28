/** Passive queue exhaustion must reach sessions_send notify callers, not only the Gateway log. */
import { afterEach, expect, it } from "vitest";
import {
  enqueueSystemEventEntry,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { notifySessionsSendSession } from "./sessions-send-tool.delivery.js";

const sessionKey = "agent:main:notify-queue-capacity";
const displayKey = "agent:main:notify-queue-capacity";

afterEach(() => resetSystemEventsForTest());

function notify(runId = "notify-queue-capacity-run") {
  return notifySessionsSendSession({
    message: "Are you still there?",
    inputProvenance: {
      kind: "inter_session",
      sourceSessionKey: "agent:main:main",
      sourceTool: "sessions_send",
    },
    sessionKey,
    targetAgentId: "main",
    runId,
    displayKey,
  });
}

it("reports passive queue exhaustion instead of losing the capacity explanation", async () => {
  for (let index = 0; index < 20; index += 1) {
    expect(
      enqueueSystemEventEntry(`Exec completed (${index})`, {
        sessionKey,
        contextKey: `exec:${index}`,
      }),
    ).not.toBeNull();
  }

  const result = await notify();

  expect(result.details).toMatchObject({ status: "error", sessionKey: displayKey });
  expect(result.details?.error).toContain("Notification was not queued");
  expect(result.details?.error).toContain("System event queue is full (20 pending)");
  expect(peekSystemEvents(sessionKey)).toHaveLength(20);
});

it("keeps the generic receipt for a duplicate notification that claims nothing", async () => {
  const first = await notify();
  expect(first.details).toMatchObject({ status: "queued" });

  const duplicate = await notify();

  expect(duplicate.details).toMatchObject({
    status: "error",
    error: "Notification was not queued.",
  });
});
