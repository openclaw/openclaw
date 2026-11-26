import { describe, expect, it } from "vitest";
import {
  attachInternalToolResultProvenance,
  copyInternalToolResultState,
} from "../../packages/agent-core/src/internal-hooks.js";
import {
  consumeToolExecutionNotStarted,
  markToolEffectReceipt,
  markToolExecutionNotStarted,
  markToolExecutionRefused,
  readToolEffectReceipt,
  readToolExecutionRefusal,
} from "./tool-effect-receipt.js";

describe("private tool effect receipts", () => {
  it.each(["read_completed", "failed_no_effect", "mutation_committed", "uncertain"] as const)(
    "preserves %s through host copies without making serialized fields authoritative",
    (state) => {
      const result = markToolEffectReceipt({ details: { effectReceipt: { state } } }, state);
      const projected = copyInternalToolResultState(result, { content: [] });

      expect(readToolEffectReceipt(projected)).toEqual({ state });
      expect(Object.isFrozen(readToolEffectReceipt(projected))).toBe(true);
      expect(consumeToolExecutionNotStarted(projected)).toBe(false);
      expect(readToolEffectReceipt(projected)).toEqual({ state });
      expect(readToolEffectReceipt(structuredClone(result))).toBeUndefined();
      expect(
        readToolEffectReceipt(attachInternalToolResultProvenance({}, { state })),
      ).toBeUndefined();
    },
  );

  it("keeps existing no-start and refusal receipts consumable after a host projection", () => {
    const refusal = { kind: "blocked", reason: "Synthetic policy refusal" } as const;
    for (const result of [markToolExecutionNotStarted({}), markToolExecutionRefused({}, refusal)]) {
      const projected = copyInternalToolResultState(result, {});
      expect(readToolEffectReceipt(projected)).toEqual({ state: "not_started" });
      if (readToolExecutionRefusal(result)) {
        expect(readToolExecutionRefusal(projected)).toEqual(refusal);
      }
      expect(consumeToolExecutionNotStarted(projected)).toBe(true);
      expect(readToolEffectReceipt(projected)).toBeUndefined();
      expect(readToolExecutionRefusal(projected)).toBeUndefined();
      expect(consumeToolExecutionNotStarted(projected)).toBe(false);
    }
  });
});
