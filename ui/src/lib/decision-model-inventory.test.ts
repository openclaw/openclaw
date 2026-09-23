// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../src/config/merge-patch.js";
import {
  decisionModelRemovalPatch,
  readDecisionModelInventory,
} from "./decision-model-inventory.ts";

const available = ["one", "two", "unused"].map((id) => ({
  provider: "fixture",
  id,
  name: id,
  pluginId: "fixture",
}));

describe("configured decision model inventory", () => {
  const config = {
    models: {
      decisionModels: ["fixture/one", "fixture/two", "fixture/one"],
      providers: { keep: {} },
    },
    agents: {
      defaults: {
        decisionModel: "fixture/one",
        decisionModelsByTask: { decision_evaluate: "fixture/one", "sample/off": "" },
      },
      entries: {
        worker: { decisionModel: "fixture/one", model: "chat/keep" },
        disabled: {
          decisionModel: "",
          decisionModelsByTask: {
            "sample/dormant": "fixture/one",
            "sample/stale": "missing/model",
          },
        },
      },
    },
  };

  it("unions explicit models and every saved use without adding the available catalog", () => {
    const inventory = readDecisionModelInventory(config, available);
    expect(inventory.map((entry) => entry.ref)).toEqual([
      "fixture/one",
      "fixture/two",
      "missing/model",
    ]);
    expect(inventory[0]?.uses).toEqual([
      { agentId: undefined },
      { agentId: undefined, taskId: "decision_evaluate" },
      { agentId: "worker" },
      { agentId: "disabled", taskId: "sample/dormant" },
    ]);
    expect(inventory[2]?.available).toBe(false);
    expect(
      readDecisionModelInventory({ agents: config.agents }, available).map((entry) => entry.ref),
    ).toEqual(["fixture/one", "missing/model"]);
  });

  it("atomically replaces all uses while preserving explicit disables and unrelated config", () => {
    const patch = decisionModelRemovalPatch(
      readDecisionModelInventory(config, available),
      "fixture/one",
      "fixture/two",
    );
    expect(patch).not.toBeNull();
    const next = applyMergePatch(config, patch);
    expect(next).toEqual({
      models: { decisionModels: ["fixture/two", "missing/model"], providers: { keep: {} } },
      agents: {
        defaults: {
          decisionModel: "fixture/two",
          decisionModelsByTask: { decision_evaluate: "fixture/two", "sample/off": "" },
        },
        entries: {
          worker: { decisionModel: "fixture/two", model: "chat/keep" },
          disabled: {
            decisionModel: "",
            decisionModelsByTask: {
              "sample/dormant": "fixture/two",
              "sample/stale": "missing/model",
            },
          },
        },
      },
    });
  });

  it("removes unused models without changing assignments and rejects missing or unusable replacements", () => {
    const inventory = readDecisionModelInventory(config, available);
    expect(decisionModelRemovalPatch(inventory, "fixture/two", "")).toEqual({
      models: { decisionModels: ["fixture/one", "missing/model"] },
    });
    for (const replacement of ["", "fixture/one", "fixture/unused", "missing/model"]) {
      expect(decisionModelRemovalPatch(inventory, "fixture/one", replacement)).toBeNull();
    }
  });
});
