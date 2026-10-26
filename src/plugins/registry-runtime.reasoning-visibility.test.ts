import { expect, it } from "vitest";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import {
  bindReplyReasoningVisibility,
  createReplyReasoningVisibility,
  isReplyReasoningVisible,
} from "../auto-reply/reply/reasoning-visibility.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { revokePluginRecord } from "./registry-lifecycle.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { createPluginRuntime } from "./runtime/index.js";

it("reads producing-turn reasoning after dispatch consumer closes without retaining its callbacks", async () => {
  await withOpenClawTestState({ label: "reasoning-dispatch-custody" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:matrix:room:queued",
      storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
    };
    await replaceSessionEntry(scope, {
      sessionId: "reasoning-session",
      updatedAt: 1,
      reasoningLevel: "on",
    });
    const owner = await createReplyReasoningVisibility({
      ...scope,
      sessionEntry: loadSessionEntryReadOnly(scope),
      authorized: true,
      resolvedLevel: "on",
    });
    const payload = { text: "Private reasoning", isReasoning: true };
    bindReplyReasoningVisibility(payload, owner);
    const builder = createRuntimeTestRegistry(createPluginRuntime());
    const record = createPluginRecord({
      id: "matrix",
      source: "/plugins/matrix/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    try {
      const api = builder.createApi(record, { config: {}, pluginConfig: {} });
      const instance = getPluginInstance(record);
      expect(instance).toBeDefined();
      if (!instance) {
        throw new Error("Plugin instance was not admitted");
      }
      const consumer = instance.retainConsumer();
      let capturedPredicate: typeof isReplyReasoningVisible = () => false;
      const publish = consumer.wrap((predicate: typeof isReplyReasoningVisible) => {
        capturedPredicate = predicate;
      });
      try {
        publish(isReplyReasoningVisible);
        expect(capturedPredicate(payload)).toBe(true);
        // A deferred dispatch returns while the producing turn's payload remains queued.
        owner.retainForQueue(() => false);
        await Promise.resolve();
      } finally {
        consumer.release();
      }
      expect(instance.hasRetainedConsumers).toBe(false);
      expect(() => publish(isReplyReasoningVisible)).toThrow("consumer is closed");
      expect(() => capturedPredicate(payload)).toThrow("consumer is closed");

      const readVisibility = api.runtime.channel.reply.isReasoningVisible;
      expect(readVisibility).toBeTypeOf("function");
      if (!readVisibility) {
        throw new Error("Host reasoning reader is unavailable");
      }
      expect(readVisibility(payload)).toBe(true);
      expect(readVisibility({ text: "Unbound", isReasoning: true })).toBe(false);
      expect(
        readVisibility(
          setReplyPayloadMetadata(
            { text: "Forged", isReasoning: true },
            { reasoningVisibilityOwner: {} },
          ),
        ),
      ).toBe(false);
      emitSessionLifecycleEvent({ ...scope, reason: "patch", reasoningLevel: "off" });
      expect(readVisibility(payload)).toBe(false);
      owner.close();
      expect(readVisibility(payload)).toBe(false);
      revokePluginRecord(builder.registry, record);
      expect(() => readVisibility(payload)).toThrow("runtime is no longer active");
    } finally {
      owner.close();
      await disposePluginRegistryInstances(builder.registry);
    }
  });
});
