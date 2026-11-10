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
  portUsage,
} from "./restart-health.test-helpers.js";

function listenerUsage(pid = 4300, errors?: string[]) {
  return portUsage([{ pid, commandLine: "openclaw-gateway" }], { errors });
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
  },
);

it("bounds replacement health after an indefinite previous-owner wait", async () => {
  inspectPortUsage.mockResolvedValue(portUsage());
  const previousLockIdentity = mockGatewayLockReplacement();

  const snapshot = await waitForListener({
    previousLockIdentity,
    attempts: 2,
    waitIndefinitelyForPreviousOwner: true,
  });

  expect(snapshot.healthy).toBe(false);
  expect(sleep).toHaveBeenCalledTimes(3);
});

it.each(["final-delay", "missing", "read-failure"] as const)(
  "settles replacement ownership after %s",
  async (scenario) => {
    const previous = mockGatewayLockReplacement();
    readActiveGatewayLockIdentity.mockReset();
    const replacement = { ...previous, pid: 4300, ownerId: "replacement" };
    if (scenario === "read-failure") {
      readActiveGatewayLockIdentity.mockRejectedValueOnce(new Error("transient lock read failure"));
    }
    readActiveGatewayLockIdentity
      .mockResolvedValueOnce(previous)
      .mockResolvedValue(scenario === "missing" ? undefined : replacement);
    const missing = scenario === "missing";
    const snapshot = await waitForListener({
      previousLockIdentity: previous,
      ...(missing ? { attempts: 2 } : {}),
      waitIndefinitelyForPreviousOwner: scenario !== "final-delay",
    });
    expect(snapshot.healthy).toBe(!missing);
    expect(inspectPortUsage).toHaveBeenCalledTimes(missing ? 0 : 1);
    expect(sleep).toHaveBeenCalledTimes(missing ? 3 : scenario === "read-failure" ? 2 : 1);
    if (missing) {
      expect(snapshot.portUsage.errors).toEqual([
        `Previous gateway lock owner ${previous.ownerId ?? previous.pid} is still active.`,
      ]);
    }
  },
);

it("stops external-listener health polling once the command signal is aborted", async () => {
  const controller = new AbortController();
  const aborted = new Error("restart-interrupt");
  callGateway.mockRejectedValue(new Error("connect ECONNREFUSED"));
  sleep.mockImplementationOnce(async () => {
    controller.abort(aborted);
  });

  await expect(
    waitForListener({ attempts: 3, delayMs: 60_000, signal: controller.signal }),
  ).rejects.toBe(aborted);
  expect(sleep).toHaveBeenCalledWith(60_000, controller.signal);
});

it("stops an in-flight listener probe once the command signal is aborted", async () => {
  const controller = new AbortController();
  const aborted = new Error("restart-interrupt");
  callGateway.mockImplementation(async () => {
    controller.abort(aborted);
    throw new Error("connect ECONNREFUSED");
  });

  await expect(
    waitForListener({ attempts: 3, delayMs: 60_000, signal: controller.signal }),
  ).rejects.toBe(aborted);
  expect(sleep).not.toHaveBeenCalled();
});

it("stops waiting for the previous lock owner to release once the command signal is aborted", async () => {
  const controller = new AbortController();
  const aborted = new Error("restart-interrupt");
  const previousLockIdentity = mockGatewayLockReplacement();
  readActiveGatewayLockIdentity.mockResolvedValue(previousLockIdentity);
  sleep.mockImplementationOnce(async () => {
    controller.abort(aborted);
  });

  await expect(
    waitForListener({
      attempts: 3,
      delayMs: 60_000,
      previousLockIdentity,
      signal: controller.signal,
    }),
  ).rejects.toBe(aborted);
  expect(sleep).toHaveBeenCalledWith(60_000, controller.signal);
});
