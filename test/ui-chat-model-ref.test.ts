import { describe, expect, it } from "vitest";
import { buildChatModelOption, resolveServerChatModelValue } from "../ui/src/ui/chat-model-ref.ts";

describe("Control UI chat model refs", () => {
  it("keeps same-provider-qualified ids unchanged", () => {
    expect(
      buildChatModelOption({
        id: "lmstudio_mbp/qwen3.5-9b",
        name: "Qwen 3.5 9B",
        provider: "lmstudio_mbp",
      }),
    ).toEqual({
      value: "lmstudio_mbp/qwen3.5-9b",
      label: "lmstudio_mbp/qwen3.5-9b · lmstudio_mbp",
    });
    expect(resolveServerChatModelValue("lmstudio_mbp/qwen3.5-9b", "lmstudio_mbp")).toBe(
      "lmstudio_mbp/qwen3.5-9b",
    );
  });
});
