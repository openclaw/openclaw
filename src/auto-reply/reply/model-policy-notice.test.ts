import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { attachModelPolicyNotice } from "./model-policy-notice.js";

function session(): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 1,
    providerOverride: "openai",
    modelOverride: "old-model",
  };
}

function reply(
  entry: SessionEntry,
  payloads: [ReplyPayload, ...ReplyPayload[]] = [{ text: "Answer" }],
) {
  return attachModelPolicyNotice({
    payloads,
    pinnedModel: `${entry.providerOverride}/${entry.modelOverride}`,
    primaryModel: "openai/default-model",
    sessionEntry: entry,
    sessionKey: "agent:main:main",
    storePath: "/tmp/policy-notice-test/sessions.json",
  });
}

describe("model policy reply notice", () => {
  it("preserves the pin and repeats when delivery has no transcript publication authority", async () => {
    const entry = session();
    const first = reply(entry);
    expect(first[0].text).toContain("Pinned model openai/old-model is not in your allow list");
    expect(first[0].text).toContain("used the default (openai/default-model)");
    expect(first[0].text).toContain("Use /model to change it.\n\nAnswer");
    expect(entry.modelPolicyNotice).toBeUndefined();
    expect(reply(entry)[0].text).toBe(first[0].text);
    const acknowledge = getReplyPayloadMetadata(first[0])?.onFinalDeliverySuccess;
    expect(acknowledge).toBeTypeOf("function");
    await acknowledge?.();
    expect(entry.modelPolicyNotice).toBeUndefined();
    expect(reply(entry)[0].text).toBe(first[0].text);
    expect(entry).toMatchObject({ providerOverride: "openai", modelOverride: "old-model" });
  });

  it("omits the notice when the current pin and session have a recorded receipt", () => {
    const entry = session();
    entry.modelPolicyNotice = {
      sessionId: entry.sessionId,
      pinnedModel: "openai/old-model",
    };
    expect(reply(entry)).toEqual([{ text: "Answer" }]);
    expect(entry).toMatchObject({ providerOverride: "openai", modelOverride: "old-model" });
  });

  it.each(["pin", "session"])("notifies when a recorded receipt has a different %s", (changed) => {
    const entry = session();
    entry.modelPolicyNotice = {
      sessionId: changed === "session" ? "old-session" : entry.sessionId,
      pinnedModel: changed === "pin" ? "openai/another-model" : "openai/old-model",
    };
    expect(reply(entry)[0].text).toBe(
      "Pinned model openai/old-model is not in your allow list. This reply used the default (openai/default-model). Use /model to change it.\n\nAnswer",
    );
  });

  it("explains an unavailable primary without consuming the success notice", async () => {
    const entry = session();
    const payload = reply(entry, [{ text: "No credentials", isError: true }])[0];
    expect(payload.text).toContain("configured default could not answer. Use /model");
    expect(payload.text).toContain("No credentials");
    await getReplyPayloadMetadata(payload)?.onFinalDeliverySuccess?.();
    expect(entry.modelPolicyNotice).toBeUndefined();
  });

  it("does not create speech from silence or reasoning", () => {
    const entry = session();
    for (const payload of [{ text: "NO_REPLY" }, { text: "thinking", isReasoning: true }]) {
      expect(reply(entry, [payload])).toEqual([payload]);
    }
    expect(reply(entry, [{ text: "NO_REPLY" }, { text: "Answer" }, { text: "More" }])).toEqual([
      { text: "NO_REPLY" },
      { text: expect.stringContaining("Use /model to change it.\n\nAnswer") },
      { text: "More" },
    ]);
  });
});
