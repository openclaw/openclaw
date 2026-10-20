import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { runGatewayResume, runGatewaySuspend } from "./suspend-cli.js";

vi.mock("node:timers/promises", { spy: true });

const readyResult = {
  status: "ready" as const,
  suspensionId: "suspension-1",
  expiresAtMs: Date.parse("2026-08-11T12:00:00.000Z"),
  activeCount: 0,
  blockers: [],
};

const busyResult = {
  status: "busy" as const,
  reason: "active-work" as const,
  retryAfterMs: 200,
  activeCount: 1,
  blockers: [{ kind: "root-request" as const, count: 1, message: "1 active request" }],
};

describe("gateway suspend CLI", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.restoreAllMocks());

  it("prints a ready lease without exposing remote credentials in the resume hint", async () => {
    const callGateway = vi.fn(async () => readyResult);
    const runtime = createNonExitingRuntimeEnv();
    const rpcOpts = { url: "wss://gateway.example:19444", token: "opaque-credential" };

    await runGatewaySuspend({ rpcOpts, waitSeconds: 0 }, { callGateway, runtime });

    expect(callGateway).toHaveBeenCalledWith("gateway.suspend.prepare", rpcOpts, {
      requestId: expect.stringMatching(/^cli-[0-9a-f]{8}$/u),
    });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(runtime.log).toHaveBeenCalledWith("Gateway suspension prepared.");
    expect(runtime.log).toHaveBeenCalledWith("Suspension ID: suspension-1");
    expect(runtime.log).toHaveBeenCalledWith(
      `Expires: 2026-08-11T12:00:00.000Z (${readyResult.expiresAtMs} ms)`,
    );
    expect(runtime.log).toHaveBeenCalledWith("Resume with: openclaw gateway resume suspension-1");
  });

  it("rejects whitespace-only wait before acquiring a lease", async () => {
    const callGateway = vi.fn(async () => readyResult);

    await expect(
      runGatewaySuspend(
        { rpcOpts: {}, waitSeconds: " \t\n" },
        { callGateway, runtime: createNonExitingRuntimeEnv() },
      ),
    ).rejects.toThrow("--wait must be a non-negative number of seconds");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "named profile and custom local port",
      rpcOpts: { localPortOverride: 18999 },
      profile: "work",
      container: "",
      command: "openclaw --profile work gateway resume suspension-1 --port 18999",
    },
    {
      name: "container takes precedence over profile",
      rpcOpts: { localPortOverride: 18999 },
      profile: "work",
      container: "demo",
      command: "openclaw --container demo gateway resume suspension-1 --port 18999",
    },
  ])(
    "prints a correctly scoped resume hint for $name",
    async ({ rpcOpts, profile, container, command }) => {
      vi.stubEnv("OPENCLAW_PROFILE", profile);
      vi.stubEnv("OPENCLAW_CONTAINER_HINT", container);
      const runtime = createNonExitingRuntimeEnv();

      await runGatewaySuspend(
        { rpcOpts },
        { callGateway: vi.fn(async () => readyResult), runtime },
      );

      expect(runtime.log).toHaveBeenCalledWith(`Resume with: ${command}`);
    },
  );

  it("reports blockers without polling when --wait is omitted", async () => {
    const callGateway = vi.fn(async () => busyResult);

    await expect(
      runGatewaySuspend(
        { rpcOpts: {}, requestId: "host-operation" },
        { callGateway, runtime: createNonExitingRuntimeEnv() },
      ),
    ).rejects.toThrow(
      "Gateway suspension is busy (active-work; 1 active).\nBlockers:\n- 1 active request\nRetry later or use --wait <seconds>.",
    );
    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("polls with one stable request id until the Gateway is ready", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce(busyResult)
      .mockResolvedValueOnce(readyResult);
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(sleep).mockImplementation(async (delayMs = 0) => {
      now += delayMs;
    });

    await runGatewaySuspend(
      { rpcOpts: {}, requestId: "host-operation", waitSeconds: "2" },
      { callGateway, runtime: createNonExitingRuntimeEnv() },
    );

    expect(sleep).toHaveBeenCalledExactlyOnceWith(200);
    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(callGateway.mock.calls.map((call) => call[2])).toEqual([
      { requestId: "host-operation" },
      { requestId: "host-operation" },
    ]);
  });

  it("emits the latest busy result and exits nonzero in JSON mode", async () => {
    const runtime = createNonExitingRuntimeEnv();

    await runGatewaySuspend(
      { rpcOpts: { json: true }, requestId: "host-operation", json: true },
      { callGateway: vi.fn(async () => busyResult), runtime },
    );

    expect(runtime.writeJson).toHaveBeenCalledWith({
      ...busyResult,
      requestId: "host-operation",
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("never issues another prepare after a sleep overshoots the deadline", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(sleep).mockImplementation(async () => {
      // A lagging clock can wake far past the advertised --wait window.
      now += 10_000;
    });
    const callGateway = vi.fn(async () => busyResult);

    await expect(
      runGatewaySuspend(
        { rpcOpts: {}, requestId: "host-operation", waitSeconds: "0.2" },
        { callGateway, runtime: createNonExitingRuntimeEnv() },
      ),
    ).rejects.toThrow(
      "Gateway suspension is busy (active-work; 1 active).\nBlockers:\n- 1 active request\nTimed out waiting for the Gateway to become idle.",
    );
    expect(callGateway).toHaveBeenCalledOnce();
  });
});

describe("gateway resume CLI", () => {
  it.each([
    { resumed: true, message: "Gateway resumed." },
    {
      resumed: false,
      message:
        "No matching suspension was held (lease already expired or resumed); gateway is running.",
    },
  ])("prints the resumed=$resumed outcome", async ({ resumed, message }) => {
    const runtime = createNonExitingRuntimeEnv();
    const callGateway = vi.fn(async () => ({ ok: true, status: "running", resumed }));

    await runGatewayResume({ rpcOpts: {}, suspensionId: "suspension-1" }, { callGateway, runtime });

    expect(callGateway).toHaveBeenCalledExactlyOnceWith(
      "gateway.suspend.resume",
      {},
      { suspensionId: "suspension-1" },
    );
    expect(runtime.log).toHaveBeenCalledExactlyOnceWith(message);
  });
});
