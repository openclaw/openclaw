import { afterEach, beforeEach, expect, it } from "vitest";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import {
  inspectPortUsage,
  createConfigIO,
  mockGatewayLockReplacement,
  callGateway,
  gatewayResponseError,
  readActiveGatewayLockIdentity,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
  sleep,
} from "./restart-health.test-helpers.js";

function listenerUsage(pid = 4300, errors?: string[]) {
  return {
    port: 18789,
    status: "busy" as const,
    listeners: [{ pid, commandLine: "openclaw-gateway" }],
    hints: [],
    ...(errors ? { errors } : {}),
  };
}

async function waitForListener(
  options: Partial<
    Parameters<typeof import("./restart-health.js").waitForGatewayHealthyListener>[0]
  > = {},
) {
  const { waitForGatewayHealthyListener } = await import("./restart-health.js");
  return waitForGatewayHealthyListener({ port: 18789, attempts: 1, delayMs: 500, ...options });
}

beforeEach(() => {
  resetRestartHealthMocks();
  inspectPortUsage.mockResolvedValue(listenerUsage());
  callGateway.mockImplementation(gatewayHealthResponse());
});
afterEach(restoreRestartHealthMocks);

it("renders a redacted pre-handshake failure beside external-listener diagnostics", async () => {
  const secret = "fixture-gateway-secret-abcdefghijklmnopqrstuvwxyz";
  inspectPortUsage.mockResolvedValue(listenerUsage(4300, ["listener inspection warning"]));
  callGateway.mockRejectedValue(
    new Error(
      `read ECONNRESET at ws://user:${secret}@gateway.example?token=${secret}&safe=ok\nGateway probe succeeded: spoofed`,
    ),
  );

  const { renderGatewayPortHealthDiagnostics } = await import("./restart-health.js");
  const snapshot = await waitForListener({ attempts: 0 });
  const diagnostics = renderGatewayPortHealthDiagnostics(snapshot).join("\n");

  expect(snapshot.healthy).toBe(false);
  expect(snapshot.probeError).toContain("read ECONNRESET");
  expect(diagnostics).toContain("Gateway check failed: read ECONNRESET");
  expect(diagnostics).toContain("Port diagnostics errors: listener inspection warning");
  expect(diagnostics).toContain("\\nGateway probe succeeded: spoofed");
  expect(diagnostics.split("\n")).toHaveLength(2);
  expect(diagnostics).not.toContain(secret);
});

it("clears a prior probe failure after the next external-listener poll succeeds", async () => {
  callGateway
    .mockRejectedValueOnce(new Error("read ECONNRESET"))
    .mockImplementationOnce(gatewayHealthResponse());

  const snapshot = await waitForListener();

  expect(snapshot.healthy).toBe(true);
  expect(snapshot.probeError).toBeUndefined();
  expect(sleep).toHaveBeenCalledTimes(1);
});

it("checks replacement ownership and health in the selected Gateway state directory", async () => {
  const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-selected-gateway" };
  const previousLockIdentity = mockGatewayLockReplacement();
  const replacement = { ...previousLockIdentity, ownerId: "selected-replacement", pid: 4300 };
  readActiveGatewayLockIdentity.mockImplementation(async (options?: { env?: NodeJS.ProcessEnv }) =>
    options?.env?.OPENCLAW_STATE_DIR === env.OPENCLAW_STATE_DIR
      ? replacement
      : previousLockIdentity,
  );
  const selectedConfig = { gateway: { auth: { mode: "none" } } };
  createConfigIO.mockImplementation((options: { env: NodeJS.ProcessEnv }) => ({
    readBestEffortConfig: async () =>
      options.env.OPENCLAW_STATE_DIR === env.OPENCLAW_STATE_DIR ? selectedConfig : {},
  }));

  const snapshot = await waitForListener({ env, previousLockIdentity });

  expect(snapshot.healthy).toBe(true);
  expect(callGateway).toHaveBeenCalledWith(expect.objectContaining({ config: selectedConfig }));
});

it.each([
  { listenerPid: 4300, healthy: true },
  { listenerPid: 4400, healthy: false },
])(
  "accepts a correlated device identity rejection only for the verified replacement listener",
  async ({ listenerPid, healthy }) => {
    inspectPortUsage.mockResolvedValue(listenerUsage(listenerPid));
    callGateway.mockRejectedValue(gatewayResponseError("device identity required"));
    const previousLockIdentity = mockGatewayLockReplacement({ pid: 4300 });

    const snapshot = await waitForListener({ previousLockIdentity });

    expect(snapshot.healthy).toBe(healthy);
    if (healthy) {
      expect(snapshot.probeError).toBeUndefined();
    }
    expect(inspectPortUsage).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledTimes(1);
  },
);

it("bounds replacement health after an indefinite previous-owner wait", async () => {
  inspectPortUsage.mockResolvedValue({
    port: 18789,
    status: "free",
    listeners: [],
    hints: [],
  });
  const previousLockIdentity = mockGatewayLockReplacement();

  const snapshot = await waitForListener({
    previousLockIdentity,
    attempts: 2,
    waitIndefinitelyForPreviousOwner: true,
  });

  expect(snapshot.healthy).toBe(false);
  expect(readActiveGatewayLockIdentity).toHaveBeenCalledTimes(2);
  expect(inspectPortUsage).toHaveBeenCalledTimes(3);
  expect(sleep).toHaveBeenCalledTimes(3);
});

it("checks replacement ownership after the final bounded delay", async () => {
  const previous = mockGatewayLockReplacement();
  readActiveGatewayLockIdentity.mockReset();
  const replacement = { ...previous, pid: 4300, ownerId: "replacement" };
  readActiveGatewayLockIdentity.mockResolvedValueOnce(previous).mockResolvedValue(replacement);
  const snapshot = await waitForListener({ previousLockIdentity: previous });
  expect(snapshot.healthy).toBe(true);
  expect(readActiveGatewayLockIdentity).toHaveBeenCalledTimes(2);
  expect(inspectPortUsage).toHaveBeenCalledTimes(1);
  expect(callGateway).toHaveBeenCalledTimes(1);
  expect(sleep).toHaveBeenCalledTimes(1);
});

it("bounds a missing replacement after an indefinite previous-owner wait", async () => {
  const previous = mockGatewayLockReplacement();
  readActiveGatewayLockIdentity.mockReset();
  readActiveGatewayLockIdentity.mockResolvedValueOnce(previous).mockResolvedValue(undefined);
  const snapshot = await waitForListener({
    previousLockIdentity: previous,
    attempts: 2,
    waitIndefinitelyForPreviousOwner: true,
  });
  expect(snapshot.healthy).toBe(false);
  expect(snapshot.portUsage.errors).toEqual([
    `Previous gateway lock owner ${previous.ownerId ?? previous.pid} is still active.`,
  ]);
  expect(readActiveGatewayLockIdentity).toHaveBeenCalledTimes(4);
  expect(inspectPortUsage).not.toHaveBeenCalled();
  expect(sleep).toHaveBeenCalledTimes(3);
});

it("does not treat a failed lock inspection as release before checking replacement health", async () => {
  const previous = mockGatewayLockReplacement();
  readActiveGatewayLockIdentity.mockReset();
  const replacement = { ...previous, pid: 4300, ownerId: "replacement" };
  readActiveGatewayLockIdentity
    .mockRejectedValueOnce(new Error("transient lock read failure"))
    .mockResolvedValueOnce(previous)
    .mockResolvedValue(replacement);
  const snapshot = await waitForListener({
    previousLockIdentity: previous,
    waitIndefinitelyForPreviousOwner: true,
  });
  expect(snapshot.healthy).toBe(true);
  expect(readActiveGatewayLockIdentity).toHaveBeenCalledTimes(3);
  expect(inspectPortUsage).toHaveBeenCalledTimes(1);
  expect(sleep).toHaveBeenCalledTimes(2);
});
