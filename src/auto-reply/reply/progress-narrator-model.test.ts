import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import {
  generateNarrationWithUtilityModel,
  prepareNarrationModel,
} from "./progress-narrator-model.js";

const complete = vi.hoisted(() => vi.fn());
// mock-isolation: Narration fixtures control completion without loading live auth/provider state.
vi.mock("../../agents/isolated-completion.js", () => ({ runIsolatedCompletion: complete }));
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
const utilityConfig = {
  agents: {
    defaults: {
      model: { primary: "utility-test/main", fallbacks: ["utility-test/main-backup"] },
      utilityModel: { primary: "utility-test/primary", fallbacks: ["utility-test/backup"] },
    },
  },
  plugins: { enabled: false },
};
beforeEach(() => {
  vi.useFakeTimers();
  complete.mockReset();
});
afterEach(() => vi.useRealTimers());

it.each(["fallback", "exhausted", "direct", "aborted"] as const)(
  "narration completion: %s",
  async (mode) => {
    const utility = mode === "fallback" || mode === "exhausted";
    const cfg = utility ? utilityConfig : {};
    const selected = utility ? await prepareNarrationModel({ cfg, agentId: "main" }) : prepared;
    if (!selected) {
      throw new Error("Utility model preparation failed");
    }
    const text = utility ? "Checking the requested fix." : "Working on the request.";
    complete.mockImplementation(async ({ model }) => {
      if (utility && (model !== "backup" || mode === "exhausted")) {
        throw new FailoverError("Fixture server unavailable", { reason: "server_error" });
      }
      return { text };
    });
    const result = await generateNarrationWithUtilityModel({
      cfg,
      prepared: selected,
      timeoutMs: 6_000,
      input: utility
        ? { userMessage: "Check the fix", activityNotes: [], previousText: "" }
        : { userMessage: "Inspect the fixture", activityNotes: ["Tool read"], previousText: "" },
      abortSignal: mode === "aborted" ? AbortSignal.abort() : new AbortController().signal,
    });
    expect(result.text).toBe(mode === "exhausted" || mode === "aborted" ? null : text);
    expect(complete.mock.calls.map(([call]) => call.model)).toEqual(
      mode === "aborted" ? [] : utility ? ["primary", "backup"] : ["gpt-test"],
    );
    if (utility) {
      expect(result.error).toEqual(mode === "exhausted" ? expect.any(String) : undefined);
    }
    if (mode === "direct") {
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: "progress-narration", timeoutMs: 6_000 }),
      );
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);
