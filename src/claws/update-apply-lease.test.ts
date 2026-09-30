import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { applyClawUpdatePlan } from "./update-apply.js";
import { consent, manifest, plan, source } from "./update-apply.test-helpers.js";

it("does not rebuild while the canonical agent deletion owner is live", async () => {
  await withOpenClawTestState({ label: "claw-update-delete-exclusion" }, async (state) => {
    const deletionEntered = createDeferred();
    const releaseDeletion = createDeferred();
    const deletion = withAgentDeletion(
      "worker",
      async () => {
        deletionEntered.resolve();
        await releaseDeletion.promise;
      },
      { env: state.env },
    );
    await deletionEntered.promise;

    const controller = new AbortController();
    const rebuildPlan = vi.fn();
    const updatePlan = plan([]);
    const update = applyClawUpdatePlan(
      updatePlan,
      { targetManifest: manifest, targetSource: source },
      {
        config: {},
        ...consent(updatePlan),
        env: state.env,
        signal: controller.signal,
        rebuildPlan,
      },
    );
    await Promise.resolve();
    controller.abort(new Error("stop waiting for deletion"));

    await expect(update).rejects.toMatchObject({ code: "update_lease_failed" });
    expect(rebuildPlan).not.toHaveBeenCalled();
    releaseDeletion.resolve();
    await deletion;
  });
});
