import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

beforeEach(() => {
  vi.useFakeTimers();
  complete.mockReset();
  complete.mockResolvedValue({
    text: "Working on the request.",
    provider: "openai",
    model: "gpt-test",
    owner: { kind: "harness", id: "openclaw" },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("progress narration completion cancellation", () => {
  it.each([false, true])(
    "uses the independent utility chain and preserves exhaustion behavior: exhausted=%s",
    async (exhausted) => {
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
      expect(selected).not.toBeNull();
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
        cfg,
        prepared: selected,
        input: { userMessage: "Check the fix", activityNotes: [], previousText: "" },
      });

      expect(result.text).toBe(exhausted ? null : "Checking the requested fix.");
      expect(result.error).toEqual(exhausted ? expect.any(String) : undefined);
      expect(complete.mock.calls.map(([request]) => request.model)).toEqual(["primary", "backup"]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([false, true])(
    "does not dispatch an already aborted request: aborted=%s",
    async (aborted) => {
      const controller = new AbortController();
      if (aborted) {
        controller.abort();
      }

      const result = await generateNarrationWithUtilityModel({
        cfg: {},
        prepared,
        input: {
          userMessage: "Inspect the fixture",
          activityNotes: ["Tool read"],
          previousText: "",
        },
        abortSignal: controller.signal,
      });

      expect(complete).toHaveBeenCalledTimes(aborted ? 0 : 1);
      if (!aborted) {
        expect(complete).toHaveBeenCalledWith(
          expect.objectContaining({ purpose: "progress-narration" }),
        );
      }
      expect(result.text).toBe(aborted ? null : "Working on the request.");
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
