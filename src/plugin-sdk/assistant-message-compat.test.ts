import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { expectTypeOf, it } from "vitest";

it("accepts the optional assistant delivery field shipped in v2026.10.1", () => {
  const delivery: NonNullable<AssistantMessage["openclawDelivery"]> = {
    textPhaseRequiresTerminal: true,
  };
  expectTypeOf(delivery.textPhaseRequiresTerminal).toEqualTypeOf<true | undefined>();
});
