import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  // The wait window runs on the monotonic clock; the mocked sleeps advance
  // the same reading the way real elapsed time would.
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.mocked(sleep).mockImplementation(async (delayMs = 0) => {
    now += advance(delayMs);
  });
}

it("prints a ready lease without exposing remote credentials in the resume hint", async () => {
  vi.stubEnv("OPENCLAW_PROFILE", "work");
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", "demo");
  const rpcOpts = {
    url: "wss://url-user:url-password@gateway.example:19444/private?token=url-secret",
    token: "opaque-credential",
    localPortOverride: 18999,
  };

  await suspend({ rpcOpts, waitSeconds: 0 });

  expect(callGateway).toHaveBeenCalledExactlyOnceWith("gateway.suspend.prepare", rpcOpts, {
    requestId: expect.stringMatching(/^cli-[0-9a-f]{8}$/u),
  });
  expect(runtime.log).toHaveBeenCalledWith("Suspension ID: suspension-1");
  expect(runtime.log).toHaveBeenCalledWith(
    `Expires: 2026-08-11T12:00:00.000Z (${readyResult.expiresAtMs} ms)`,
  );
  expect(runtime.log).toHaveBeenCalledWith(
    "To resume this remote Gateway, run openclaw --container demo gateway resume suspension-1 with the same --url and authentication options used for suspend.",
  );
  const output = vi.mocked(runtime.log).mock.calls.flat().join("\n");
  expect(output).not.toContain(rpcOpts.url);
  expect(output).not.toContain(rpcOpts.token);
  expect(output).not.toContain("url-secret");
  expect(output).not.toContain("Resume with:");
});

it.each([
  {
    name: "named profile and custom local port",
    profile: "work",
    container: "",
    command: "openclaw --profile work gateway resume suspension-1 --port 18999",
  },
  {
    name: "container takes precedence over profile",
    profile: "work",
    container: "demo",
    command: "openclaw --container demo gateway resume suspension-1 --port 18999",
  },
])("prints a correctly scoped resume hint for $name", async ({ profile, container, command }) => {
  vi.stubEnv("OPENCLAW_PROFILE", profile);
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", container);

  await suspend({ rpcOpts: { localPortOverride: 18999 } });

  expect(runtime.log).toHaveBeenCalledWith(`Resume with: ${command}`);
});

it("rejects whitespace-only wait before acquiring a lease", async () => {
  await expect(suspend({ waitSeconds: " \t\n" })).rejects.toThrow(
    "--wait must be a non-negative number of seconds",
  );
  expect(callGateway).not.toHaveBeenCalled();
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
  expect(callGateway.mock.calls.map((call) => call[2])).toEqual([
    { requestId: "host-operation" },
    { requestId: "host-operation" },
  ]);
  expect(runtime.log).toHaveBeenCalledWith("Resume with: openclaw gateway resume suspension-1");
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
it.each([
  [true, "Gateway resumed."],
  [
    false,
    "No matching suspension was held (lease already expired or resumed); gateway is running.",
  ],
] as const)("prints the resumed=%s outcome", async (resumed, message) => {
  callGateway.mockResolvedValue({ resumed });

  await runGatewayResume({ rpcOpts: {}, suspensionId: "suspension-1" }, { callGateway, runtime });

  expect(callGateway).toHaveBeenCalledExactlyOnceWith(
    "gateway.suspend.resume",
    {},
    { suspensionId: "suspension-1" },
  );
  expect(runtime.log).toHaveBeenCalledExactlyOnceWith(message);
});
