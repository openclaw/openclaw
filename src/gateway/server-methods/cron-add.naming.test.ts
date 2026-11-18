import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  agentTurnCronParams,
  createCronTestContext,
  createCronTestInvoker,
  expectCronSuccess,
  requireCronAddPayload,
} from "./cron.validation.test-support.js";

const getRuntimeConfig = vi.hoisted(() =>
  vi.fn<() => OpenClawConfig>(() => ({}) as OpenClawConfig),
);
const generateAutomationName = vi.hoisted(() =>
  vi.fn<(params: { agentId: string; message: string }) => Promise<string | null>>(),
);

vi.mock("../../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js")),
  getRuntimeConfig,
}));

// These fixtures have no inference account or live delivery metadata.
vi.mock("../../cron/inference-binding.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cron/inference-binding.runtime.js")>()),
  captureCronInferenceBinding: async () => undefined,
}));
vi.mock("../../cron/delivery-preview.js", () => ({
  resolveCronDeliveryFailurePreview: async () => undefined,
  resolveCronDeliveryPreview: async () => ({ label: "not requested", detail: "not requested" }),
  resolveCronDeliveryPreviews: async () => ({}),
}));
vi.mock("../dashboard-session-title.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dashboard-session-title.js")>()),
  generateAutomationName,
}));

import { cronHandlers } from "./cron.js";

const invokeCron = createCronTestInvoker(cronHandlers, getRuntimeConfig);

async function addJob(params: Record<string, unknown>) {
  const context = createCronTestContext(undefined, getRuntimeConfig);
  const { respond } = await invokeCron("cron.add", params, { context });
  expectCronSuccess(respond);
  return requireCronAddPayload(context);
}

describe("cron.add naming", () => {
  beforeEach(() => {
    generateAutomationName.mockReset();
  });

  it("names an unnamed automation from its prompt", async () => {
    generateAutomationName.mockResolvedValue("Morning inbox summary");
    const { name: _name, ...params } = agentTurnCronParams({
      payload: { kind: "agentTurn", message: "Summarize my inbox every morning" },
    });

    const job = await addJob(params);

    expect(job.name).toBe("Morning inbox summary");
    expect(generateAutomationName).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", message: "Summarize my inbox every morning" }),
    );
  });

  it("keeps the prompt-derived name when no model answers", async () => {
    generateAutomationName.mockResolvedValue(null);
    const job = await addJob(
      agentTurnCronParams({
        name: "   ",
        payload: { kind: "agentTurn", message: "Water the garden\nthen report" },
      }),
    );

    expect(job.name).toBe("Water the garden");
  });

  it.each([
    ["an authored name", { name: "Garden check" }],
    ["a declaration key", { name: undefined, declarationKey: "garden-check" }],
  ])("does not generate a name for %s", async (_scenario, overrides) => {
    const job = await addJob(agentTurnCronParams(overrides));

    expect(generateAutomationName).not.toHaveBeenCalled();
    expect(job.name).toBe(overrides.name ?? "hello");
  });
});
