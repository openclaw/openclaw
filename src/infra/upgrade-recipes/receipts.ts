import {
  parseUpgradeRecipeStepBinding,
  upgradeRecipeStepObservationSchema,
  upgradeRecipeStepPostconditionMatches,
  upgradeRecipeStepReceiptSchema,
  type UpgradeRecipeStepBinding,
  type UpgradeRecipeStepObservation,
  type UpgradeRecipeStepReceipt,
  type UpgradeRecipeStepWriteInput,
} from "./receipts-contract.js";

/** The executor supplies existing fenced worker operations and its child-settlement checks. */
export type UpgradeRecipeStepReceiptPort = {
  assertCurrent: () => void;
  assertEffectsSettled: () => void;
  read: (binding: UpgradeRecipeStepBinding) => Promise<UpgradeRecipeStepReceipt | null>;
  record: (input: UpgradeRecipeStepWriteInput) => Promise<UpgradeRecipeStepReceipt>;
};

export type UpgradeRecipeStepPreparation =
  | { kind: "intent-recorded"; receipt: UpgradeRecipeStepReceipt }
  | { kind: "reconciliation-required"; receipt: UpgradeRecipeStepReceipt };
export type UpgradeRecipeStepReconciliation = {
  kind: "verified" | "outcome-unknown" | "postcondition-drift";
  receipt: UpgradeRecipeStepReceipt;
};

/** A receipt coordinator, not an executor: it never acquires a lease or invokes a migration. */
export function createUpgradeRecipeStepReceiptRecorder(
  selected: UpgradeRecipeStepBinding,
  port: UpgradeRecipeStepReceiptPort,
) {
  const binding = parseUpgradeRecipeStepBinding(selected);
  const checkReceipt = (value: UpgradeRecipeStepReceipt) => {
    const receipt = upgradeRecipeStepReceiptSchema.parse(value);
    if (JSON.stringify(receipt.binding) !== JSON.stringify(binding)) {
      throw new Error(
        "Recipe receipt returned a different run, plan, adapter, or resource identity.",
      );
    }
    return receipt;
  };
  const read = async () => {
    port.assertCurrent();
    const receipt = await port.read(structuredClone(binding));
    port.assertCurrent();
    return receipt === null ? null : checkReceipt(receipt);
  };
  const record = async (input: UpgradeRecipeStepWriteInput) => {
    port.assertCurrent();
    const receipt = await port.record(input);
    port.assertCurrent();
    return checkReceipt(receipt);
  };
  return {
    binding: structuredClone(binding),
    read,
    prepareIntent: async (): Promise<UpgradeRecipeStepPreparation> => {
      const current = await read();
      if (current) {
        return { kind: "reconciliation-required", receipt: current };
      }
      // Lost/unknown acknowledgments propagate. Only a new passive read may reconcile them.
      const receipt = await record({
        kind: "intent",
        binding: structuredClone(binding),
        expectedRevision: null,
      });
      if (receipt.phase !== "intent" || receipt.revision !== 1) {
        throw new Error("Recipe intent was not durably recorded before its effect.");
      }
      return { kind: "intent-recorded", receipt };
    },
    reconcile: async (
      observeCurrentState: () => Promise<UpgradeRecipeStepObservation>,
    ): Promise<UpgradeRecipeStepReconciliation> => {
      const current = await read();
      if (!current) {
        throw new Error("Recipe step has no durable intent to reconcile.");
      }
      port.assertEffectsSettled();
      port.assertCurrent();
      const observation = upgradeRecipeStepObservationSchema.parse(await observeCurrentState());
      port.assertCurrent();
      port.assertEffectsSettled();
      const verified = upgradeRecipeStepPostconditionMatches(binding, observation);
      if (current.phase === "verified") {
        // Preserve the exact historical outcome; newer state is not grounds to rerun or rewind it.
        return { kind: verified ? "verified" : "postcondition-drift", receipt: current };
      }
      const receipt = await record({
        kind: "observation",
        binding: structuredClone(binding),
        expectedRevision: current.revision,
        observation,
      });
      return { kind: receipt.phase === "verified" ? "verified" : "outcome-unknown", receipt };
    },
  };
}
