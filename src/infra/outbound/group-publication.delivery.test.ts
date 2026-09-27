import { afterAll, beforeAll, expect, it } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { sendDurableMessageBatchCore } from "../../channels/message/send.js";
import { setActivePluginRegistry, resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeAll(async () => {
  state = await createOpenClawTestState({ prefix: "group-publication-", applyEnv: true });
});
afterAll(async () => {
  resetPluginRuntimeStateForTest();
  await state.cleanup();
});

it("blocks a stale approved draft after an awaited dispatch while ordinary replies still send", async () => {
  const sent: string[] = [];
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "telegram",
          outbound: {
            deliveryMode: "direct",
            sendText: async ({ text }) => {
              sent.push(text);
              return { channel: "telegram", messageId: `sent-${sent.length}` };
            },
          },
        }),
      },
    ]),
  );
  const enteredDispatch = createDeferredCore();
  const releaseDispatch = createDeferredCore();
  let revision = 1;
  const payload = setReplyPayloadMetadata(
    { text: "The obsolete unsolicited answer." },
    {
      publicationAuthority: {
        recoveryMode: "reconcile-only",
        assertCurrent: () => {
          if (revision !== 1) {
            throw new Error("The group conversation changed");
          }
        },
      },
    },
  );
  const delivery = sendDurableMessageBatchCore({
    cfg: {},
    channel: "telegram",
    to: "-100123",
    payloads: [payload],
    onPlatformSendDispatch: async () => {
      enteredDispatch.resolve();
      await releaseDispatch.promise;
    },
  });
  await Promise.race([
    enteredDispatch.promise,
    delivery.then((result) => {
      throw new Error(`Delivery ended before dispatch: ${JSON.stringify(result)}`, {
        cause:
          result.status === "failed" || result.status === "partial_failed"
            ? result.error
            : undefined,
      });
    }),
  ]);
  revision++;
  releaseDispatch.resolve();
  const stale = await delivery;
  expect(stale.status).toBe("failed");
  expect(sent).toEqual([]);

  const ordinary = await sendDurableMessageBatchCore({
    cfg: {},
    channel: "telegram",
    to: "-100123",
    payloads: [{ text: "An ordinary reply." }],
  });
  expect(ordinary.status).toBe("sent");
  expect(sent).toEqual(["An ordinary reply."]);
});
