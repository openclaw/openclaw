import { describe, expect, it } from "vitest";
import { validateCronUpdateParams } from "../../packages/gateway-protocol/src/index.js";
import { normalizeCronJobPatch } from "./normalize.js";

describe("normalizeCronJobPatch payload timeout clears", () => {
  it("preserves explicit null timeout clear in agent payload patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        kind: "agentTurn",
        timeoutSeconds: null,
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.timeoutSeconds).toBeNull();
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });
});
