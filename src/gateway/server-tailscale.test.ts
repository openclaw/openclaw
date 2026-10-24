import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, makeClaim } = vi.hoisted(() => {
  const stopRouteClaim = vi.fn<() => Promise<void>>(async () => undefined);
  const claimFixture = (exited = new Promise<void>(() => {}), active = true) => ({
    exited,
    isActive: () => active,
    stop: stopRouteClaim,
  });
  const tailscaleMocks = {
    stopRouteClaim,
    claimTailscaleRoute: vi.fn(async (_mode: "serve" | "funnel", _target: number | string) =>
      claimFixture(),
    ),
    getTailnetHostname: vi.fn<() => Promise<string | null>>(async () => null),
    getTailnetHostnameAfterServe: vi.fn<() => Promise<string | null>>(async () => null),
    hasTailscaleFunnelRouteForPort: vi.fn(async (_port: number) => false),
  };
  return { mocks: tailscaleMocks, makeClaim: claimFixture };
});

vi.mock("../infra/tailscale.js", () => ({
  claimTailscaleRoute: mocks.claimTailscaleRoute,
  getTailnetHostname: mocks.getTailnetHostname,
  getTailnetHostnameAfterServe: mocks.getTailnetHostnameAfterServe,
  hasTailscaleFunnelRouteForPort: mocks.hasTailscaleFunnelRouteForPort,
}));

import { createDeferred } from "../../test/helpers/promise.js";
import { TailscaleRouteOwnershipConflictError } from "../infra/tailscale-route-ownership-error.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { resolveControlUiIdentity } from "./control-ui-identity.js";
import { startGatewayTailscaleExposure as startGatewayTailscaleExposureBase } from "./server-tailscale.js";
import {
  getTailscalePublishedOrigin,
  prepareTailscalePublishedOrigin,
} from "./tailscale-published-origin.js";

const MANAGED_BACKEND_PORT = 19_000;
const logTailscale = { info: vi.fn(), warn: vi.fn() };
function startGatewayTailscaleExposure(
  params: Partial<Omit<Parameters<typeof startGatewayTailscaleExposureBase>[0], "backend">> = {},
) {
  return startGatewayTailscaleExposureBase({
    tailscaleMode: "serve",
    port: 18789,
    logTailscale,
    ...params,
    backend: { host: "127.0.0.1", port: MANAGED_BACKEND_PORT },
  });
}

function expectNoControlUiIdentity() {
  expect(
    resolveControlUiIdentity(
      { gateway: { publicOrigin: "https://unrelated.test", tailscale: { mode: "serve" } } },
      { mode: "token", allowTailscale: true },
    ),
  ).toBeUndefined();
}

function expectClaim(mode: "serve" | "funnel") {
  expect(mocks.claimTailscaleRoute).toHaveBeenCalledWith(
    mode,
    MANAGED_BACKEND_PORT,
    18789,
    expect.any(Function),
    undefined,
  );
}

beforeEach(resetSecretRedactionRegistryForTest);

afterEach(() => {
  resetSecretRedactionRegistryForTest();
  prepareTailscalePublishedOrigin({ origin: "https://reset.test", mode: "serve" })();
  for (const fn of [...Object.values(mocks), ...Object.values(logTailscale)]) {
    fn.mockReset();
  }
  mocks.claimTailscaleRoute.mockImplementation(async () => makeClaim());
  mocks.stopRouteClaim.mockResolvedValue(undefined);
  mocks.getTailnetHostname.mockResolvedValue(null);
  mocks.getTailnetHostnameAfterServe.mockResolvedValue(null);
  mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(false);
});

describe("startGatewayTailscaleExposure", () => {
  it.each(["off", "serve"] as const)(
    "does not mutate %s without a backend",
    async (tailscaleMode) => {
      const starting = startGatewayTailscaleExposureBase({
        tailscaleMode,
        port: 18789,
        logTailscale,
      });
      if (tailscaleMode === "off") {
        await expect(starting).resolves.toBeNull();
      } else {
        await expect(starting).rejects.toThrow("Managed Tailscale ingress failed to start");
      }
      expect(mocks.claimTailscaleRoute).not.toHaveBeenCalled();
    },
  );

  it("fails startup when the managed route cannot be claimed", async () => {
    const failure = new Error("tailscale unavailable");
    mocks.claimTailscaleRoute.mockRejectedValue(failure);

    await expect(startGatewayTailscaleExposure()).rejects.toBe(failure);
  });

  it("fails startup when the route owner exits after reporting readiness", async () => {
    mocks.claimTailscaleRoute.mockResolvedValue(makeClaim(Promise.resolve(), false));

    await expect(startGatewayTailscaleExposure()).rejects.toThrow("claim exited during startup");
    expect(mocks.stopRouteClaim).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "joins claim cleanup when startup stops during hostname discovery (cleanup fails=%s)",
    async (cleanupFails) => {
      const hostnameStarted = createDeferred();
      const hostname = createDeferred<string>();
      const stopped = createDeferred();
      const controller = new AbortController();
      const interrupted = new Error("Gateway stopped during hostname discovery");
      const cleanupError = new Error("claim process could not be stopped");
      mocks.getTailnetHostnameAfterServe.mockImplementation(() => {
        hostnameStarted.resolve();
        return hostname.promise;
      });
      mocks.stopRouteClaim.mockImplementation(() => stopped.promise);
      const starting = startGatewayTailscaleExposure({ signal: controller.signal });
      const result = starting.then(
        () => "started",
        (error: unknown) => error,
      );
      await hostnameStarted.promise;
      controller.abort(interrupted);
      hostname.resolve("fixture.tailnet.ts.net");
      if (cleanupFails) {
        stopped.reject(cleanupError);
        expect(await result).toMatchObject({
          name: "AggregateError",
          errors: [interrupted, cleanupError],
          cause: cleanupError,
        });
      } else {
        stopped.resolve();
        expect(await result).toBe(interrupted);
      }
      expect(mocks.stopRouteClaim).toHaveBeenCalledOnce();
      expect(getTailscalePublishedOrigin()).toBeUndefined();
    },
  );

  it("keeps the Gateway up with complete migration guidance for an external Funnel", async () => {
    mocks.getTailnetHostname.mockResolvedValue("node.tailnet.ts.net");
    mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(true);

    const cleanup = await startGatewayTailscaleExposure({ preserveFunnel: true });

    expect(cleanup).toBeNull();
    expect(getTailscalePublishedOrigin()).toBeUndefined();
    expect(mocks.hasTailscaleFunnelRouteForPort).toHaveBeenCalledWith(18789);
    expect(mocks.claimTailscaleRoute).not.toHaveBeenCalled();
    expect(logTailscale.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /plugin-authenticated.*gateway\.auth\.password.*gateway\.auth\.mode=password.*mode funnel.*unset/s,
      ),
    );
  });

  it("fails closed when preserved Funnel status cannot be inspected", async () => {
    const failure = new Error("tailscale status unavailable");
    mocks.hasTailscaleFunnelRouteForPort.mockRejectedValue(failure);

    await expect(startGatewayTailscaleExposure({ preserveFunnel: true })).rejects.toBe(failure);
    expect(mocks.claimTailscaleRoute).not.toHaveBeenCalled();
    expect(logTailscale.warn).toHaveBeenCalledWith(expect.stringContaining(failure.message));
  });

  it("claims Serve without an existing Funnel and owns its tailnet-only origin", async () => {
    mocks.getTailnetHostnameAfterServe.mockResolvedValue("node.tailnet.ts.net");

    const cleanup = await startGatewayTailscaleExposure({ preserveFunnel: true });

    expect(mocks.hasTailscaleFunnelRouteForPort).toHaveBeenCalledWith(18789);
    expectClaim("serve");
    expect(getTailscalePublishedOrigin()).toMatchObject({
      origin: "https://node.tailnet.ts.net",
      mode: "serve",
    });
    expect(resolveControlUiIdentity({}, { mode: "token", allowTailscale: true })?.url).toBe(
      "https://node.tailnet.ts.net/",
    );
    await cleanup?.();
    expect(getTailscalePublishedOrigin()).toBeUndefined();
    expectNoControlUiIdentity();
  });

  it.each(["serve", "funnel"] as const)(
    "warns without releasing the %s claim when hostname discovery fails",
    async (mode) => {
      const failure = new Error("status output exceeded its buffer");
      mocks.getTailnetHostname.mockRejectedValue(failure);
      mocks.getTailnetHostnameAfterServe.mockRejectedValue(failure);
      const cleanup = await startGatewayTailscaleExposure({ tailscaleMode: mode });

      expect(logTailscale.warn).toHaveBeenCalledWith(expect.stringContaining(failure.message));
      expect(getTailscalePublishedOrigin()).toBeUndefined();
      expect(mocks.stopRouteClaim).not.toHaveBeenCalled();
      await cleanup?.();
      expect(mocks.stopRouteClaim).toHaveBeenCalledOnce();
    },
  );

  it("clears the published origin and warns when the foreground claim exits", async () => {
    const { promise: exited, resolve: resolveExit } = createDeferred();
    mocks.claimTailscaleRoute.mockResolvedValue(makeClaim(exited));
    mocks.getTailnetHostnameAfterServe.mockResolvedValue("node.tailnet.ts.net");
    const cleanup = await startGatewayTailscaleExposure();
    resolveExit();

    await vi.waitFor(() => {
      expect(logTailscale.warn).toHaveBeenCalledWith(expect.stringContaining("claim exited"));
    });
    expect(getTailscalePublishedOrigin()).toBeUndefined();
    expectNoControlUiIdentity();
    await cleanup?.();
  });

  it("never consults the Funnel route helper when running in funnel mode", async () => {
    mocks.getTailnetHostname.mockResolvedValue("node.tailnet.ts.net");

    await startGatewayTailscaleExposure({
      tailscaleMode: "funnel",
      preserveFunnel: true,
    });

    expect(mocks.hasTailscaleFunnelRouteForPort).not.toHaveBeenCalled();
    expect(getTailscalePublishedOrigin()).toMatchObject({
      origin: "https://node.tailnet.ts.net",
      mode: "funnel",
    });
    expectNoControlUiIdentity();
    expectClaim("funnel");
  });
});

describe("managed Tailscale claim recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function recoverableClaim() {
    const exited = createDeferred();
    let active = true;
    const exit = () => {
      active = false;
      exited.resolve();
    };
    return {
      exited: exited.promise,
      isActive: () => active,
      stop: vi.fn(async () => exit()),
      exit,
    };
  }

  it("keeps retrying transient failures while the daemon returns", async () => {
    const original = recoverableClaim();
    const replacement = recoverableClaim();
    mocks.claimTailscaleRoute
      .mockResolvedValueOnce(original)
      .mockRejectedValueOnce(new Error("Tailscale is stopped"))
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(replacement);
    mocks.getTailnetHostnameAfterServe.mockResolvedValue("fixture.tailnet.ts.net");
    const startup = new AbortController();
    const cleanup = await startGatewayTailscaleExposure({ signal: startup.signal });
    startup.abort();
    try {
      const previousOrigin = getTailscalePublishedOrigin();
      original.exit();
      await vi.advanceTimersByTimeAsync(0);
      expect(previousOrigin?.signal.aborted).toBe(true);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await vi.advanceTimersToNextTimerAsync();
        expect(getTailscalePublishedOrigin()).toBeUndefined();
      }
      await vi.advanceTimersToNextTimerAsync();
      expect(getTailscalePublishedOrigin()?.origin).toBe("https://fixture.tailnet.ts.net");
      expect(mocks.claimTailscaleRoute).toHaveBeenCalledTimes(4);
    } finally {
      await cleanup?.();
    }
  });

  it("stops retrying when another owner has claimed the HTTPS port", async () => {
    const original = recoverableClaim();
    mocks.claimTailscaleRoute
      .mockResolvedValueOnce(original)
      .mockRejectedValue(new TailscaleRouteOwnershipConflictError());
    const cleanup = await startGatewayTailscaleExposure();
    try {
      original.exit();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersToNextTimerAsync();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mocks.claimTailscaleRoute).toHaveBeenCalledTimes(2);
      expect(getTailscalePublishedOrigin()).toBeUndefined();
      expect(logTailscale.warn).toHaveBeenCalledWith(expect.stringContaining("already owned"));
    } finally {
      await cleanup?.();
    }
  });

  it("cancels a pending backoff when the Gateway closes", async () => {
    const original = recoverableClaim();
    mocks.claimTailscaleRoute.mockResolvedValueOnce(original);
    const cleanup = await startGatewayTailscaleExposure();
    original.exit();
    await vi.advanceTimersByTimeAsync(0);
    await cleanup?.();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.claimTailscaleRoute).toHaveBeenCalledOnce();
    expect(getTailscalePublishedOrigin()).toBeUndefined();
  });

  it.each([false, true])(
    "joins replacement cleanup during shutdown (cleanup fails=%s)",
    async (cleanupFails) => {
      const original = recoverableClaim();
      const replacement = recoverableClaim();
      const cleanupError = new Error("claim process could not be stopped");
      if (cleanupFails) {
        replacement.stop.mockRejectedValue(cleanupError);
      }
      mocks.claimTailscaleRoute.mockResolvedValueOnce(original).mockResolvedValueOnce(replacement);
      const hostname = createDeferred<string>();
      mocks.getTailnetHostnameAfterServe
        .mockResolvedValueOnce("fixture.tailnet.ts.net")
        .mockReturnValueOnce(hostname.promise);
      const cleanup = await startGatewayTailscaleExposure();
      try {
        original.exit();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersToNextTimerAsync();
        expect(mocks.getTailnetHostnameAfterServe).toHaveBeenCalledTimes(2);
        if (cleanupFails) {
          await expect(cleanup?.()).rejects.toMatchObject({
            name: "AggregateError",
            cause: cleanupError,
          });
        } else {
          await cleanup?.();
        }
        expect(replacement.stop).toHaveBeenCalledOnce();
        hostname.resolve("late.tailnet.ts.net");
        await vi.advanceTimersByTimeAsync(120_000);
        expect(getTailscalePublishedOrigin()).toBeUndefined();
        expect(mocks.claimTailscaleRoute).toHaveBeenCalledTimes(2);
      } finally {
        hostname.resolve("late.tailnet.ts.net");
      }
    },
  );
});
