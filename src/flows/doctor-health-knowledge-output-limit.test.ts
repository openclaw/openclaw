import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { showDoctorHealthSummary } from "./doctor-health-contribution.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";

it("plain doctor shows the Knowledge saving-model output-limit warning", async () => {
  const contribution = resolveDoctorHealthContributions().filter(
    (candidate) => candidate.id === "doctor:knowledge-model-output-limit",
  );
  expect(contribution).toHaveLength(1);
  const ctx = createDoctorHealthFlowContext({
    // Partial model row: config defaults fill the rest, as Doctor sees authored config.
    cfg: {
      plugins: { slots: { memory: "knowledge" } },
      agents: { defaults: { model: { primary: "local/small" } } },
      models: {
        providers: {
          local: { baseUrl: "http://local.test/v1", models: [{ id: "small", name: "small" }] },
        },
      },
    } as unknown as OpenClawConfig,
  });
  await runDoctorHealthContributionList(ctx, contribution);
  showDoctorHealthSummary(ctx);
  expect(ctx.runtime.log).toHaveBeenCalledWith(
    expect.stringContaining("Knowledge saves with local/small, which can write only 8192 tokens"),
  );
});
