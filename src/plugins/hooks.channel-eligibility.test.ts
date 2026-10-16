import { describe, expect, it, vi } from "vitest";
import type { PluginHookRegistrationOptions } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function register(hookName: "reply_payload_sending" | "message_sending", scope: unknown) {
  const builder = createTestPluginRegistry();
  const api = builder.createApi(createPluginRecord({ id: "scoped-outbound", origin: "bundled" }), {
    config: {},
  });
  const handler = vi.fn(() => ({ cancel: true }));
  const opts: PluginHookRegistrationOptions<typeof hookName> = {};
  Reflect.set(opts, "eligibleChannels", scope);
  api.on(hookName, handler, opts);
  return { handler, runner: createHookRunner(builder.registry), registry: builder.registry };
}

for (const hookName of ["reply_payload_sending", "message_sending"] as const) {
  describe(`${hookName} channel eligibility`, () => {
    it.each([
      { channelId: "discord", eligible: false },
      { channelId: "imessage", eligible: true },
      { channelId: "", eligible: true },
      { channelId: "Discord", eligible: true },
      { channelId: "channel:123", eligible: true },
    ])("aligns presence and execution for $channelId", async ({ channelId, eligible }) => {
      const { handler, runner } = register(hookName, ["imessage"]);
      const ctx = { channelId };
      expect(runner.hasHooks(hookName, ctx)).toBe(eligible);
      const result =
        hookName === "reply_payload_sending"
          ? await runner.runReplyPayloadSending(
              { payload: { text: "original" }, kind: "final" },
              ctx,
            )
          : await runner.runMessageSending({ to: "test", content: "original" }, ctx);
      expect(result?.cancel === true).toBe(eligible);
      expect(handler).toHaveBeenCalledTimes(eligible ? 1 : 0);
    });

    it("keeps Discord-scoped modifiers applicable", async () => {
      const { handler, runner } = register(hookName, ["discord"]);
      const ctx = { channelId: "discord" };
      expect(runner.hasHooks(hookName, ctx)).toBe(true);
      if (hookName === "reply_payload_sending") {
        await runner.runReplyPayloadSending({ payload: { text: "original" }, kind: "final" }, ctx);
      } else {
        await runner.runMessageSending({ to: "test", content: "original" }, ctx);
      }
      expect(handler).toHaveBeenCalledOnce();
    });

    it("keeps missing context eligible", () => {
      const { runner } = register(hookName, ["imessage"]);
      expect(runner.hasHooks(hookName)).toBe(true);
      expect(runner.hasHooks(hookName, {})).toBe(true);
    });

    it.each([
      undefined,
      null,
      [],
      "imessage",
      ["imessage", ""],
      ["IMESSAGE"],
      ["channel:123"],
      Array(1),
    ])("keeps malformed or omitted registration unrestricted (%j)", async (scope) => {
      const { handler, runner } = register(hookName, scope);
      const ctx = { channelId: "discord" };
      expect(runner.hasHooks(hookName, ctx)).toBe(true);
      if (hookName === "reply_payload_sending") {
        await runner.runReplyPayloadSending({ payload: { text: "original" }, kind: "final" }, ctx);
      } else {
        await runner.runMessageSending({ to: "test", content: "original" }, ctx);
      }
      expect(handler).toHaveBeenCalledOnce();
    });

    it("preserves custom channel identifiers and deduplicates registration", () => {
      const { registry, runner } = register(hookName, ["custom-chat", "imessage", "imessage"]);
      expect(registry.typedHooks[0]?.eligibleChannels).toEqual(["custom-chat", "imessage"]);
      expect(runner.hasHooks(hookName, { channelId: "custom-chat" })).toBe(true);
      expect(runner.hasHooks(hookName, { channelId: "discord" })).toBe(false);
    });
  });
}
