import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { runGatewaySuspend } from "./suspend-cli.js";

vi.mock("node:timers/promises", { spy: true });

const busyResult = {
  status: "busy" as const,
  reason: "active-work" as const,
  retryAfterMs: 150,
  activeCount: 1,
  blockers: [{ message: "1 active request" }],
};

const callGateway = vi.fn<Parameters<typeof runGatewaySuspend>[1]["callGateway"]>();
let runtime: ReturnType<typeof createNonExitingRuntimeEnv>;

beforeEach(() => {
  vi.resetAllMocks();
  runtime = createNonExitingRuntimeEnv();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("gateway suspend wait window clock domain", () => {
  it("ends the wait window at its monotonic deadline when the wall clock rewinds", async () => {
    // The mocked sleeps advance a monotonic reading the way real elapsed time
    // would, while the wall-clock reading moves backward after the first
    // prepare — the two-clock separation the series uses.
    let monotonicMs = 1_000;
    const realNow = Date.now;
    const rewoundAt = realNow() - 10 * 60_000;
    let rewound = false;
    const perfNow = vi.spyOn(performance, "now").mockImplementation(() => monotonicMs);
    const wallClock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => (rewound ? rewoundAt : Date.now()));
    const { setTimeout: sleep } = await import("node:timers/promises");
    vi.mocked(sleep).mockImplementation(async (delayMs = 0) => {
      monotonicMs += delayMs;
      if (!rewound) {
        rewound = true;
      }
    });
    callGateway.mockImplementation(async () => {
      // Each prepare observes the busy state the real gateway would report.
      return busyResult;
    });

    await runGatewaySuspend(
      { rpcOpts: {}, waitSeconds: 0.2, json: true },
      { callGateway, runtime },
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);

    // A 200ms window with 150ms retry hints ends after the second prepare on
    // the monotonic clock; a rewound wall clock would keep the window open
    // for every maxAttempts attempt.
    expect(callGateway.mock.calls.length).toBeLessThanOrEqual(3);
    expect(monotonicMs).toBeGreaterThanOrEqual(1_200);
    perfNow.mockRestore();
    wallClock.mockRestore();
  });
});
