import { describe, expect, it } from "vitest";
import {
  buildCronProceduralPlaybookSignature,
  createInMemoryCronProceduralPlaybookMemoryStoreV0,
  CronProceduralPlaybookMemoryLayerV0,
  recordCronProceduralPlaybookSignalV0,
  resolveCronProceduralPlaybookFailureKind,
} from "./procedural-playbook-memory-v0.js";

describe("resolveCronProceduralPlaybookFailureKind", () => {
  it("classifies known cron failure shapes", () => {
    expect(
      resolveCronProceduralPlaybookFailureKind({
        error: "delivery target is missing for telegram announce",
      }),
    ).toBe("delivery-target");
    expect(
      resolveCronProceduralPlaybookFailureKind({
        error: "invalid cron.add params: schedule.everyMs required",
      }),
    ).toBe("tool-validation");
    expect(
      resolveCronProceduralPlaybookFailureKind({
        error: "isolated cron jobs require payload.kind=agentTurn",
      }),
    ).toBe("runtime-validation");
    expect(
      resolveCronProceduralPlaybookFailureKind({
        error: "job timed out after 30 seconds",
      }),
    ).toBe("timeout");
  });
});

describe("CronProceduralPlaybookMemoryLayerV0", () => {
  it("records failure entries and builds ranked prompt guidance", () => {
    const store = createInMemoryCronProceduralPlaybookMemoryStoreV0();
    const layer = new CronProceduralPlaybookMemoryLayerV0({
      store,
      nowMs: () => 1_700_000_000_000,
    });

    const entry = layer.recordSignal({
      jobId: "job-1",
      jobName: "notify",
      sessionTarget: "main",
      payloadKind: "systemEvent",
      status: "error",
      error: "delivery target is missing",
    });

    expect(entry).toMatchObject({
      signature: buildCronProceduralPlaybookSignature({
        sessionTarget: "main",
        payloadKind: "systemEvent",
        failureKind: "delivery-target",
      }),
      failureKind: "delivery-target",
      failureCount: 1,
      successCount: 0,
      jobIds: ["job-1"],
      safeDefault: true,
    });

    expect(layer.getGuidance()).toEqual([
      expect.objectContaining({
        failureKind: "delivery-target",
        failureCount: 1,
        successCount: 0,
      }),
    ]);
    expect(layer.buildPromptSnippet()).toContain(
      "Procedural playbook (safe defaults from prior failures):",
    );
  });

  it("records recoveries against the prior failure signature", () => {
    const store = createInMemoryCronProceduralPlaybookMemoryStoreV0();
    const layer = new CronProceduralPlaybookMemoryLayerV0({
      store,
      nowMs: () => 1_700_000_000_000,
    });

    layer.recordSignal({
      jobId: "job-1",
      sessionTarget: "isolated",
      payloadKind: "agentTurn",
      status: "error",
      error: "invalid cron.add params: payload.message required",
    });

    const recovered = layer.recordSignal({
      jobId: "job-1",
      sessionTarget: "isolated",
      payloadKind: "agentTurn",
      status: "ok",
      error: "invalid cron.add params: payload.message required",
    });

    expect(recovered).toMatchObject({
      failureKind: "tool-validation",
      failureCount: 1,
      successCount: 1,
      jobIds: ["job-1"],
    });
  });
});

describe("recordCronProceduralPlaybookSignalV0", () => {
  it("returns undefined when disabled", () => {
    const store = createInMemoryCronProceduralPlaybookMemoryStoreV0();

    const result = recordCronProceduralPlaybookSignalV0({
      enabled: false,
      store,
      signal: {
        jobId: "job-1",
        sessionTarget: "main",
        payloadKind: "systemEvent",
        status: "error",
        error: "delivery target is missing",
      },
    });

    expect(result).toBeUndefined();
  });
});
