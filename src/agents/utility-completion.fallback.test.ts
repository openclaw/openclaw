import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { FailoverError, recordModelFallbackStop } from "./failover-error.js";
import "./model-fallback-runner.js";
import { prepareOperatorModelPolicy } from "./operator-model-policy.js";
import { prepareUtilityCompletionForAgent, runUtilityCompletion } from "./utility-completion.js";

const complete = vi.fn();

const cfg: OpenClawConfig = {
  agents: {
    defaults: {
      model: { primary: "main/large", fallbacks: ["main/expensive"] },
      utilityModel: { primary: "local/small@local:utility", fallbacks: ["backup", "other/last"] },
      models: { "other/backup": { alias: "backup" } },
    },
  },
};
const answer = {
  text: "Generated utility answer",
  provider: "other",
  model: "backup",
  owner: { kind: "harness", id: "openclaw" },
};
const request = async () => ({
  ...(await prepareUtilityCompletionForAgent({
    cfg,
    agentId: "main",
    useUtilityModel: "required",
  })),
  prompt: "Synthetic task",
  systemPrompt: "Return a short result.",
  timeoutMs: 1000,
});

beforeEach(() => {
  complete.mockReset();
});

describe("utility fallback execution", () => {
  it("resolves fallback aliases and keeps credentials and main-model fallbacks independent", async () => {
    complete
      .mockRejectedValueOnce(new FailoverError("Connection refused", { reason: "timeout" }))
      .mockResolvedValue(answer);
    await expect(runUtilityCompletion(await request(), complete)).resolves.toEqual(answer);
    expect(
      complete.mock.calls.map(([call]) => [call.provider, call.model, call.authProfileId]),
    ).toEqual([
      ["local", "small", "local:utility"],
      ["other", "backup", undefined],
    ]);
  });

  it("preserves operator model restrictions for utility fallbacks", async () => {
    complete
      .mockRejectedValueOnce(new FailoverError("Rate limited", { reason: "rate_limit" }))
      .mockResolvedValue(answer);
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "fixture",
      scopes: ["operator.write"],
      assertCurrent() {},
      modelPolicy: prepareOperatorModelPolicy({
        cfg,
        policy: { allow: ["local/*", "other/*"], deny: ["other/backup"] },
        manifestPlugins: [],
      }),
    });
    await runUtilityCompletion({ ...(await request()), operatorAuthority: authority }, complete);
    expect(complete.mock.calls.map(([call]) => `${call.provider}/${call.model}`)).toEqual([
      "local/small",
      "other/last",
    ]);
  });

  it("reads current fallbacks when reusing a prepared primary and retains its credential owner", async () => {
    complete
      .mockRejectedValueOnce(new FailoverError("Connection refused", { reason: "timeout" }))
      .mockResolvedValue(answer);
    await runUtilityCompletion(
      {
        ...(await request()),
        config: {
          ...cfg,
          agents: {
            defaults: {
              ...cfg.agents?.defaults,
              utilityModel: { primary: "local/small@local:utility", fallbacks: ["local/backup"] },
            },
          },
        },
      },
      complete,
    );
    expect(complete.mock.calls.map(([call]) => [call.model, call.authProfileId])).toEqual([
      ["small", "local:utility"],
      ["backup", "local:utility"],
    ]);
  });

  it("does not replay a terminal provider failure", async () => {
    const error = new Error("Terminal provider failure");
    recordModelFallbackStop(error);
    complete.mockRejectedValue(error);
    await expect(runUtilityCompletion(await request(), complete)).rejects.toBe(error);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("honors cancellation before another utility candidate", async () => {
    const controller = new AbortController();
    complete.mockImplementationOnce(() => {
      controller.abort(new Error("Caller cancelled"));
      throw new FailoverError("Connection refused", { reason: "timeout" });
    });
    await expect(
      runUtilityCompletion({ ...(await request()), abortSignal: controller.signal }, complete),
    ).rejects.toThrow();
    expect(complete).toHaveBeenCalledOnce();
  });
});
