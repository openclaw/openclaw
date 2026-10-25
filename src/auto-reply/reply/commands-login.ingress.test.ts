// Tests channel /login against the durable ingress drain's adoption watchdog.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
} from "../../channels/message/ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload,
  withTempState,
} from "../../channels/message/ingress-drain.test-helpers.js";
import type { ModelsAuthLoginFlowOptions } from "../../commands/models/auth.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { ReplyPayload } from "../types.js";
import {
  blockReplyOpts,
  buildLoginParams,
  runModelsAuthLoginFlowMock,
  setupLoginCommandTests,
} from "./commands-login.harness-test-support.js";

const { handleLoginCommand } = await import("./commands-login.js");

setupLoginCommandTests();

afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
});

it("adopts channel ingress before the sign-in wait so /login cancel gets through", async () => {
  vi.useFakeTimers();
  await withTempState(async (stateDir) => {
    let clock = 10_000;
    const queue = createTestIngressQueue(stateDir, { now: () => clock });
    const release = vi.spyOn(queue, "release");
    const deviceCodeSent = createDeferredCore();
    runModelsAuthLoginFlowMock.mockImplementationOnce(async (opts: ModelsAuthLoginFlowOptions) => {
      await opts.prompter.note?.("Device code ABCD-EFGH.", "Codex login");
      deviceCodeSent.resolve();
      const signal = expectDefined(opts.signal, "expected login signal");
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Codex login cancelled")), {
          once: true,
        });
      });
    });
    const replies = new Map<string, ReplyPayload | undefined>();
    const drain = createChannelIngressDrain<IngressDrainTestPayload>({
      queue,
      now: () => clock,
      dispatchClaimedEvent: async (event, lifecycle) => {
        const result = await handleLoginCommand(
          buildLoginParams(event.payload.text, {
            opts: { ...blockReplyOpts(), ...bindIngressLifecycleToReplyOptions(lifecycle) },
          }),
          true,
        );
        replies.set(event.id, result?.reply);
      },
    });
    try {
      await queue.enqueue("evt-login", { text: "/login codex" }, { laneKey: "dm" });
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await deviceCodeSent.promise;
      await queue.enqueue(
        "evt-cancel",
        { text: "/login cancel" },
        { laneKey: "dm", receivedAt: clock + 1 },
      );

      // The provider wait outlives the claim-to-adoption watchdog.
      clock += DEFAULT_INGRESS_ADOPTION_STALL_MS;
      await vi.advanceTimersByTimeAsync(DEFAULT_INGRESS_ADOPTION_STALL_MS);
      expect(release).not.toHaveBeenCalled();

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(replies.get("evt-cancel")?.text).toContain("cancelled");
      expect(replies.get("evt-login")?.text).toContain("did not complete");
      expect(await queue.listPending({ limit: "all", orderBy: "received" })).toEqual([]);
    } finally {
      drain.dispose();
    }
  });
});
