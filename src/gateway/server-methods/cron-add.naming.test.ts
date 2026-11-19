import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import {
  agentTurnCronParams,
  createCronCallerClient,
  createCronTestContext,
  createCronTestInvoker,
  expectCronSuccess,
  requireCronAddPayload,
} from "./cron.validation.test-support.js";

const getRuntimeConfig = vi.hoisted(() =>
  vi.fn<() => OpenClawConfig>(() => ({}) as OpenClawConfig),
);
const generateAutomationName = vi.hoisted(() =>
  vi.fn<typeof import("../dashboard-session-title.js").generateAutomationName>(),
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
vi.mock("../../cron/delivery-preview.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cron/delivery-preview.js")>()),
  resolveCronDeliveryFailurePreview: async () => undefined,
  resolveCronDeliveryPreview: async () => ({ label: "not requested", detail: "not requested" }),
  resolveCronDeliveryPreviews: async () => ({}),
}));
vi.mock("../dashboard-session-title.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dashboard-session-title.js")>()),
  generateAutomationName,
}));

import { cronHandlers } from "./cron.js";
import type { GatewayClient } from "./types.js";

const invokeCron = createCronTestInvoker(cronHandlers, getRuntimeConfig);

const uiClient: GatewayClient = {
  connect: gatewayConnect(["operator.cron"]),
  internal: {
    authenticatedControlUi: true,
    operatorRunAuthority: createAdmittedRunOperatorAuthority({
      profileId: "synthetic-operator",
      scopes: ["operator.cron"],
      assertCurrent() {},
    }),
  },
};

async function addJob(params: Record<string, unknown>, client: GatewayClient = uiClient) {
  const context = createCronTestContext(undefined, getRuntimeConfig);
  const { respond } = await invokeCron("cron.add", params, { context, client });
  expectCronSuccess(respond);
  return requireCronAddPayload(context);
}

function unnamedParams(message: string) {
  const { name: _name, ...params } = agentTurnCronParams({
    payload: { kind: "agentTurn", message, toolsAllow: [] },
  });
  return params;
}

describe("cron.add naming", () => {
  beforeEach(() => {
    generateAutomationName.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("names an unnamed automation from its prompt", async () => {
    generateAutomationName.mockResolvedValue("Morning inbox summary");
    const job = await addJob(unnamedParams("Summarize my inbox every morning"));

    expect(job.name).toBe("Morning inbox summary");
    expect(generateAutomationName).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        message: "Summarize my inbox every morning",
        operatorAuthority: uiClient.internal?.operatorRunAuthority,
      }),
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

  it("creates with the prompt-derived name when naming outlasts its budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const started = createDeferred<AbortSignal | undefined>();
    const late = createDeferred<string>();
    // A provider that ignores the abort must not hold the create open.
    generateAutomationName.mockImplementation(({ abortSignal }) => {
      started.resolve(abortSignal);
      return late.promise;
    });
    const pending = addJob(unnamedParams("Water the garden"));
    const signal = await started.promise;
    await vi.advanceTimersByTimeAsync(5_000);

    const job = await pending;
    expect(signal?.aborted).toBe(true);
    late.resolve("Too late");
    await vi.advanceTimersByTimeAsync(0);
    expect(job.name).toBe("Water the garden");
  });

  it("leaves agent callers to name their own jobs", async () => {
    const job = await addJob(unnamedParams("Water the garden"), createCronCallerClient("main"));

    expect(generateAutomationName).not.toHaveBeenCalled();
    expect(job.name).toBe("Water the garden");
  });

  it("keeps unnamed CLI requests local even with the same operator grant", async () => {
    const job = await addJob(unnamedParams("Water the garden"), {
      connect: gatewayConnect(["operator.cron"], { id: "cli", mode: "cli" }),
      internal: { operatorRunAuthority: uiClient.internal?.operatorRunAuthority },
    });
    expect(generateAutomationName).not.toHaveBeenCalled();
    expect(job.name).toBe("Water the garden");
  });

  it("keeps the deterministic name if there is no operator grant for inference", async () => {
    const job = await addJob(unnamedParams("Water the garden"), {
      connect: uiClient.connect,
      internal: { authenticatedControlUi: true },
    });
    expect(generateAutomationName).not.toHaveBeenCalled();
    expect(job.name).toBe("Water the garden");
  });
});
