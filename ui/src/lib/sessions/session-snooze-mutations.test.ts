// @vitest-environment node
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { sessionsResult } from "./session-capability.test-support.ts";
import { patchReceipt, sessionRow, sessionRpcHarness } from "./session-rpc.test-support.ts";

it("keeps a newer snooze when an older wake fails", async () => {
  const row = sessionRow("snooze-reminder", { snoozedUntil: 10_000, updatedAt: 1 });
  const wake = createDeferred<unknown>();
  const snooze = createDeferred<unknown>();
  const replies = [wake, snooze];
  const started = createDeferred();
  const { sessions } = sessionRpcHarness({
    "sessions.list": () => sessionsResult([row], 1),
    "sessions.patch": () => {
      const reply = replies.shift()!;
      if (reply === snooze) {
        started.resolve();
      }
      return reply.promise;
    },
    "sessions.subscribe": () => ({ subscribed: true }),
  });
  await sessions.refresh({ force: true });
  const options = { expectedSessionId: row.sessionId, deferListRefresh: true };
  const deadline = () => sessions.state.result?.sessions[0]?.snoozedUntil;
  const first = sessions.patch(row.key, { snoozedUntil: null }, options);
  expect(deadline()).toBeUndefined();
  const second = sessions.patch(row.key, { snoozedUntil: 20_000 }, options);
  expect(deadline()).toBe(20_000);
  const rejected = expect(first).rejects.toThrow("Wake was rejected");
  await started.promise;
  wake.reject(new Error("Wake was rejected"));
  await rejected;
  expect(deadline()).toBe(20_000);
  snooze.resolve(patchReceipt(row.key, { ...row, snoozedUntil: 20_000, updatedAt: 2 }));
  await second;
  expect(deadline()).toBe(20_000);
});
