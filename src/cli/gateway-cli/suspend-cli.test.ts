import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { runGatewayResume, runGatewaySuspend } from "./suspend-cli.js";

vi.mock("node:timers/promises", { spy: true });

const readyResult = {
  status: "ready" as const,
  suspensionId: "suspension-1",
  expiresAtMs: Date.parse("2026-08-11T12:00:00.000Z"),
};

const busyResult = {
  status: "busy" as const,
  reason: "active-work" as const,
  retryAfterMs: 200,
  activeCount: 1,
  blockers: [{ message: "1 active request" }],
};

describe("gateway suspend CLI", () => {
  const callGateway = vi.fn<Parameters<typeof runGatewaySuspend>[1]["callGateway"]>();
  let runtime: ReturnType<typeof createNonExitingRuntimeEnv>;
  beforeEach(() => {
    vi.resetAllMocks();
    callGateway.mockResolvedValue(readyResult);
    runtime = createNonExitingRuntimeEnv();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const suspend = (options: Partial<Parameters<typeof runGatewaySuspend>[0]> = {}) =>
    runGatewaySuspend({ rpcOpts: {}, ...options }, { callGateway, runtime });

  function mockClock(advance = (delayMs: number) => delayMs) {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(sleep).mockImplementation(async (delayMs = 0) => {
      now += advance(delayMs);
    });
  }

  it("prints a ready lease without exposing remote credentials in the resume hint", async () => {
    const rpcOpts = { url: "wss://gateway.example:19444", token: "opaque-credential" };

    await suspend({ rpcOpts, waitSeconds: 0 });

    expect(callGateway).toHaveBeenCalledExactlyOnceWith("gateway.suspend.prepare", rpcOpts, {
      requestId: expect.stringMatching(/^cli-[0-9a-f]{8}$/u),
    });
    expect(runtime.log).toHaveBeenCalledWith("Gateway suspension prepared.");
    expect(runtime.log).toHaveBeenCalledWith("Suspension ID: suspension-1");
    expect(runtime.log).toHaveBeenCalledWith(
      `Expires: 2026-08-11T12:00:00.000Z (${readyResult.expiresAtMs} ms)`,
    );
    expect(runtime.log).toHaveBeenCalledWith("Resume with: openclaw gateway resume suspension-1");
  });

  it("rejects whitespace-only wait before acquiring a lease", async () => {
    await expect(suspend({ waitSeconds: " \t\n" })).rejects.toThrow(
      "--wait must be a non-negative number of seconds",
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([
    ["", "openclaw --profile work gateway resume suspension-1 --port 18999"],
    ["demo", "openclaw --container demo gateway resume suspension-1 --port 18999"],
  ])("scopes the resume hint for work, container='%s'", async (container, command) => {
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", container);
    await suspend({ rpcOpts: { localPortOverride: 18999 } });

    expect(runtime.log).toHaveBeenCalledWith(`Resume with: ${command}`);
  });

  it.each([
    [undefined, "Retry later or use --wait <seconds>."],
    ["0.2", "Timed out waiting for the Gateway to become idle."],
  ] as const)("reports busy wait=%s without another prepare", async (waitSeconds, hint) => {
    if (waitSeconds !== undefined) {
      mockClock(() => 10_000);
    }
    callGateway.mockResolvedValue(busyResult);
    await expect(suspend({ requestId: "host-operation", waitSeconds })).rejects.toThrow(
      `Gateway suspension is busy (active-work; 1 active).\nBlockers:\n- 1 active request\n${hint}`,
    );
    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("polls with one stable request id until the Gateway is ready", async () => {
    callGateway.mockResolvedValueOnce(busyResult).mockResolvedValueOnce(readyResult);
    mockClock();

    await suspend({ requestId: "host-operation", waitSeconds: "2" });

    expect(sleep).toHaveBeenCalledExactlyOnceWith(200);
    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(callGateway.mock.calls.map((call) => call[2])).toEqual([
      { requestId: "host-operation" },
      { requestId: "host-operation" },
    ]);
  });

  it("emits the latest busy result and exits nonzero in JSON mode", async () => {
    callGateway.mockResolvedValue(busyResult);
    await suspend({ rpcOpts: { json: true }, requestId: "host-operation", json: true });

    expect(runtime.writeJson).toHaveBeenCalledWith({
      ...busyResult,
      requestId: "host-operation",
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

describe("gateway resume CLI", () => {
  it.each([
    [true, "Gateway resumed."],
    [
      false,
      "No matching suspension was held (lease already expired or resumed); gateway is running.",
    ],
  ] as const)("prints the resumed=%s outcome", async (resumed, message) => {
    const runtime = createNonExitingRuntimeEnv();
    const callGateway = vi.fn(async () => ({ resumed }));

    await runGatewayResume({ rpcOpts: {}, suspensionId: "suspension-1" }, { callGateway, runtime });

    expect(callGateway).toHaveBeenCalledExactlyOnceWith(
      "gateway.suspend.resume",
      {},
      { suspensionId: "suspension-1" },
    );
    expect(runtime.log).toHaveBeenCalledExactlyOnceWith(message);
  });
});
