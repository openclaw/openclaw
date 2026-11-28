import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { generateNarrationWithUtilityModel } from "./progress-narrator-model.js";

const complete = vi.hoisted(() => vi.fn());
vi.mock("../../agents/isolated-completion.js", () => ({
  runIsolatedCompletion: complete,
}));
vi.mock("../../agents/utility-completion.js", () => ({
  prepareUtilityCompletionForAgent: vi.fn(),
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

  it("refuses a model the turn's role denies before dispatch", async () => {
    const actual = await vi.importActual<typeof import("../../agents/isolated-completion.js")>(
      "../../agents/isolated-completion.js",
    );
    complete.mockImplementationOnce(actual.runIsolatedCompletion);
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "narration-guest",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      modelPolicy: prepareOperatorModelPolicy({ cfg: {}, policy: { allow: [] } }),
    });

    const result = await generateNarrationWithUtilityModel({
      cfg: {},
      prepared,
      input: { userMessage: "Inspect the fixture", activityNotes: [], previousText: "" },
      operatorAuthority,
    });

    expect(result.text).toBeNull();
    expect(result.error).toContain("Your operator role cannot use this model");
  });
});
