import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("settles accepted binding writes after scheduler cancellation before closing their worker", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-binding-close");
  const entered = createDeferred();
  const release = createDeferred();
  const cancelled = createDeferred();
  let closing: Promise<void> | undefined;
  let writes: Promise<unknown> | undefined;
  let restore: (() => void) | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
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
        entered.resolve();
        await release.promise;
      }
      return scope.execute(command, executeOptions);
    });
    restore = () => spy.mockRestore();
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
    await withinTest(
      awaitGateBeforeSettlement(
        entered.promise,
        writes,
        "Binding writes settled before worker dispatch",
      ),
      signal,
    );
    kernel.scheduler.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    closing = server.close({ reason: "binding settlement close regression" });
    await withinTest(
      awaitGateBeforeSettlement(cancelled.promise, closing, "Gateway closed before its scheduler"),
      signal,
    );
    release.resolve();
    await withinTest(Promise.all([writes, closing]), signal);
    const database = new DatabaseSync(resolveOpenClawStateSqlitePath(fixture.state.env), {
      readOnly: true,
    });
    try {
      expect(
        database.prepare("SELECT target_session_key FROM current_conversation_bindings").all(),
      ).toEqual([{ target_session_key: "agent:main:new" }]);
    } finally {
      database.close();
    }
  } finally {
    vi.useRealTimers();
    release.resolve();
    await Promise.allSettled([writes, closing]);
    restore?.();
    await fixture.cleanup();
  }
});
