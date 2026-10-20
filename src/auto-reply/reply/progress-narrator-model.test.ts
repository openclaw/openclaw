import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import {
  generateNarrationWithUtilityModel,
  prepareNarrationModel,
} from "./progress-narrator-model.js";

const complete = vi.hoisted(() => vi.fn());
vi.mock("../../agents/isolated-completion.js", () => ({
  runIsolatedCompletion: complete,
}));

const prepared: Parameters<typeof generateNarrationWithUtilityModel>[0]["prepared"] = {
  config: {},
  provider: "openai",
  model: "gpt-test",
  authProfileId: undefined,
  outputTextPolicy: "strict-visible",
  thinkLevel: "off",
  agentId: "main",
  agentDir: "/unused-narration-test",
};
const request = {
  cfg: {},
  prepared,
  timeoutMs: 6_000,
  input: { userMessage: "Inspect the fixture", activityNotes: ["Tool read"], previousText: "" },
};

beforeEach(() => {
  vi.useFakeTimers();
  complete.mockReset().mockResolvedValue({ text: "Working on the request." });
});

afterEach(() => {
  vi.useRealTimers();
});

it.each([false, true])("narration utility fallback: exhausted=%s", async (exhausted) => {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "utility-test/main", fallbacks: ["utility-test/main-backup"] },
        utilityModel: {
          primary: "utility-test/primary",
          fallbacks: ["utility-test/backup"],
        },
      },
    },
    plugins: { enabled: false },
  };
  const selected = await prepareNarrationModel({ cfg, agentId: "main" });
  if (!selected) {
    throw new Error("Utility model preparation failed");
  }
  complete.mockImplementation(async ({ model }) => {
    if (model !== "backup" || exhausted) {
      throw new FailoverError("Fixture server unavailable", { reason: "server_error" });
    }
    return { text: "Checking the requested fix." };
  });

  const result = await generateNarrationWithUtilityModel({
    ...request,
    cfg,
    prepared: selected,
    input: { userMessage: "Check the fix", activityNotes: [], previousText: "" },
    abortSignal: new AbortController().signal,
  });

  expect(result.text).toBe(exhausted ? null : "Checking the requested fix.");
  expect(result.error).toEqual(exhausted ? expect.any(String) : undefined);
  expect(complete.mock.calls.map(([call]) => call.model)).toEqual(["primary", "backup"]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])("narration dispatch: aborted=%s", async (aborted) => {
  const abortSignal = aborted ? AbortSignal.abort() : new AbortController().signal;

  const result = await generateNarrationWithUtilityModel({
    ...request,
    abortSignal,
  });

  expect(complete).toHaveBeenCalledTimes(aborted ? 0 : 1);
  if (!aborted) {
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "progress-narration", timeoutMs: 6_000 }),
    );
  }
  expect(result.text).toBe(aborted ? null : "Working on the request.");
  expect(vi.getTimerCount()).toBe(0);
});
