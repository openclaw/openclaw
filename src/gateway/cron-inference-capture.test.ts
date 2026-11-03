import { beforeEach, expect, it, vi } from "vitest";
import { captureCronInferenceBinding } from "../cron/inference-binding.runtime.js";
import { captureCronCreatedInference } from "./cron-inference-capture.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

vi.mock("../cron/inference-binding.runtime.js", () => ({ captureCronInferenceBinding: vi.fn() }));
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: vi.fn(),
}));
vi.mock("./server-methods/users-model-account-access.js", () => ({
  preparePersonalModelAccountSelection: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(captureCronInferenceBinding).mockReset().mockResolvedValue(undefined);
  vi.mocked(loadGatewaySessionEntryReadOnlyInWorker)
    .mockReset()
    .mockRejectedValue(new Error("lookup reached"));
});

it.each(["current", "session:agent:secondary:target"] as const)(
  "preserves optional Gateway lookup ownership for %s while selecting the configured inference agent",
  async (sessionTarget) => {
    await expect(
      captureCronCreatedInference({
        job: {
          sessionTarget,
          sessionKey: "agent:secondary:source",
          payload: { kind: "agentTurn", message: "Run" },
        },
        cfg: {},
        agentId: "main",
        sessionLookupAgentId: undefined,
        caller: { client: null, context: {} as GatewayRequestContext, signal: undefined },
      }),
    ).rejects.toThrow("lookup reached");
    expect(loadGatewaySessionEntryReadOnlyInWorker).toHaveBeenCalledWith({
      cfg: {},
      key: sessionTarget === "current" ? "agent:secondary:source" : "agent:secondary:target",
      agentId: undefined,
    });
    expect(captureCronInferenceBinding).not.toHaveBeenCalled();
  },
);
