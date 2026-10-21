import { afterEach, expect, it, vi } from "vitest";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import { validateUpdateCandidateWithProgress } from "./update-command-candidate-validation.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";

vi.mock("../../infra/update-candidate-canary.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-candidate-canary.js")>()),
  validateUpdateCandidateCanary: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

it.each([undefined, 2_000])(
  "bounds the complete candidate validation when timeout is %s",
  async (timeoutMs) => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const budget = timeoutMs ?? 30 * 60_000;
    let signal: AbortSignal | undefined;
    vi.mocked(validateUpdateCandidateCanary).mockImplementationOnce(async (params) => {
      signal = params.signal;
      // Independent phase work has settled, but the whole validation budget has elapsed.
      now += budget + 1;
      return { status: "ok", phase: "snapshot", durationMs: budget, steps: [], logTail: [] };
    });
    await expect(
      validateUpdateCandidateWithProgress(
        {
          root: "/candidate",
          config: {},
          env: process.env,
          assertCurrent() {},
          writeOptions: createUpdateCommandExecutionGuards({}, "/candidate").captureWriteOptions(),
        },
        { timeoutMs, opts: { json: true }, progress: {} },
        undefined,
      ),
    ).rejects.toThrow("Update candidate validation exceeded");
    expect(signal?.aborted).toBe(true);
  },
);
