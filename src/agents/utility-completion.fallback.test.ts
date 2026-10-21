import { beforeEach, expect, it, vi } from "vitest";
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
type Request = Parameters<typeof runUtilityCompletion>[0];
const request = async (overrides: Partial<Request> = {}): Promise<Request> => ({
  ...(await prepareUtilityCompletionForAgent({
    cfg,
    agentId: "main",
    useUtilityModel: "required",
  })),
  prompt: "Synthetic task",
  systemPrompt: "Return a short result.",
  timeoutMs: 1000,
  ...overrides,
});
const run = async (overrides: Partial<Request> = {}) =>
  runUtilityCompletion(await request(overrides), complete);
const failThenAnswer = (reason: "timeout" | "rate_limit" = "timeout") => {
  complete
    .mockRejectedValueOnce(new FailoverError("Provider unavailable", { reason }))
    .mockResolvedValue(answer);
};

beforeEach(() => {
  complete.mockReset();
});

it("resolves fallback aliases and keeps credentials and main-model fallbacks independent", async () => {
  failThenAnswer();
  await expect(run()).resolves.toEqual(answer);
  expect(
    complete.mock.calls.map(([call]) => [call.provider, call.model, call.authProfileId]),
  ).toEqual([
    ["local", "small", "local:utility"],
    ["other", "backup", undefined],
  ]);
});

it("preserves operator model restrictions for utility fallbacks", async () => {
  failThenAnswer("rate_limit");
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
  await run({ operatorAuthority: authority });
  expect(complete.mock.calls.map(([call]) => `${call.provider}/${call.model}`)).toEqual([
    "local/small",
    "other/last",
  ]);
});

it("reads current fallbacks when reusing a prepared primary and retains its credential owner", async () => {
  failThenAnswer();
  await run({
    config: {
      ...cfg,
      agents: {
        defaults: {
          ...cfg.agents?.defaults,
          utilityModel: { primary: "local/small@local:utility", fallbacks: ["local/backup"] },
        },
      },
    },
  });
  expect(complete.mock.calls.map(([call]) => [call.model, call.authProfileId])).toEqual([
    ["small", "local:utility"],
    ["backup", "local:utility"],
  ]);
});

it("does not replay a terminal provider failure", async () => {
  const error = new Error("Terminal provider failure");
  recordModelFallbackStop(error);
  complete.mockRejectedValue(error);
  await expect(run()).rejects.toBe(error);
  expect(complete).toHaveBeenCalledOnce();
});

it("honors cancellation before another utility candidate", async () => {
  const controller = new AbortController();
  complete.mockImplementationOnce(() => {
    controller.abort(new Error("Caller cancelled"));
    throw new FailoverError("Connection refused", { reason: "timeout" });
  });
  await expect(run({ abortSignal: controller.signal })).rejects.toThrow();
  expect(complete).toHaveBeenCalledOnce();
});
