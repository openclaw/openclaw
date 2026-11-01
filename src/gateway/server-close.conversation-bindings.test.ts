import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { readClosedDatabase } from "./server-close.lifecycle.test-support.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";

it("settles accepted binding writes after scheduler cancellation before closing their worker", async ({
  signal,
}) => {
  const race = await createGatewayCloseRace("gateway-binding-close", signal);
  const { fixture, kernel } = race;
  let writes: Promise<unknown> | undefined;
  race.onCleanup(async () => {
    await Promise.allSettled([writes]);
  });
  try {
    const service = getSessionBindingService();
    const conversation = {
      channel: INTERNAL_MESSAGE_CHANNEL,
      accountId: "default",
      conversationId: "old",
    };
    const original = await service.bind({
      conversation,
      targetSessionKey: "agent:main:old",
      targetKind: "session",
    });
    const spy = probe.command(stateWorker, async (command, executeOptions, scope) => {
      if (
        command.type === "conversationBindings.bind" ||
        command.type === "conversationBindings.remove"
      ) {
        await race.block();
      }
      return scope.execute(command, executeOptions);
    });
    race.onCleanup(() => spy.mockRestore());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.scheduler.schedule({
      id: "accepted-binding-writes",
      delayMs: 0,
      async run() {
        writes = Promise.all([
          service.bind({
            conversation: { ...conversation, conversationId: "new" },
            targetSessionKey: "agent:main:new",
            targetKind: "session",
          }),
          service.unbind({
            bindingId: original.bindingId,
            scope: conversation,
            reason: "close-proof",
          }),
        ]);
        await writes;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    assert(writes);
    await race.waitForEntry(writes, "Binding writes settled before worker dispatch");
    await race.close(kernel.scheduler.signal, undefined, { reason: "binding close" });
    await race.finish(writes);
    expect(
      readClosedDatabase(
        resolveOpenClawStateSqlitePath(fixture.state.env),
        "SELECT target_session_key FROM current_conversation_bindings",
      ),
    ).toEqual([{ target_session_key: "agent:main:new" }]);
  } finally {
    vi.useRealTimers();
    await race.dispose();
  }
});
