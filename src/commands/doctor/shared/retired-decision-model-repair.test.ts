import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  createRetiredModelRefRepairResolver,
  repairRetiredConfigModelRefs,
} from "./retired-model-ref-repair.js";

it("removes a Decision selection its provider manifest retires", async () => {
  const state = await createOpenClawTestState({ label: "retired-decision-model" });
  const ref = "subq/subq-snap-preview";
  const cfg = {
    agents: { defaults: { decisionModel: ref }, entries: { main: { decisionModel: ref } } },
    plugins: {
      load: { paths: [fileURLToPath(new URL("../../../../extensions/subq", import.meta.url))] },
      entries: { subq: { enabled: true } },
    },
  };
  try {
    const resolve = createRetiredModelRefRepairResolver({ cfg, env: state.env });
    const repaired = repairRetiredConfigModelRefs(cfg, resolve);
    expect(repaired.config.agents?.defaults?.decisionModel).toBeUndefined();
    expect(repaired.config.agents?.entries?.main?.decisionModel).toBeUndefined();
    expect(repaired.changes).toContain(
      `Removed retired agents.defaults.decisionModel "${ref}"; decisions use the inherited Decision model, or stay off without one.`,
    );
  } finally {
    await state.cleanup();
  }
});
