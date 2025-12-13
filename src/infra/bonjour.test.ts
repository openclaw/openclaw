import os from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

const createService = vi.fn();
const shutdown = vi.fn();

vi.mock("@homebridge/ciao", () => {
  return {
    Protocol: { TCP: "tcp" },
    getResponder: () => ({
      createService,
      shutdown,
    }),
  };
});

const { startGatewayBonjourAdvertiser } = await import("./bonjour.js");

describe("gateway bonjour advertiser", () => {
  type ServiceCall = {
    name?: unknown;
    hostname?: unknown;
    domain?: unknown;
    txt?: unknown;
  };

  const prevEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(prevEnv)) {
      process.env[key] = value;
    }
    createService.mockReset();
    shutdown.mockReset();
    vi.restoreAllMocks();
  });

  it("does not block on advertise and publishes expected txt keys", async () => {
    // Allow advertiser to run in unit tests.
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";

    vi.spyOn(os, "hostname").mockReturnValue("test-host");

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        }),
    );
    createService.mockReturnValue({ advertise, destroy });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
      bridgePort: 18790,
      tailnetDns: "host.tailnet.ts.net",
    });

    expect(createService).toHaveBeenCalledTimes(2);
    const [masterCall, bridgeCall] = createService.mock.calls as Array<
      [Record<string, unknown>]
    >;
    expect(masterCall?.[0]?.type).toBe("clawdis-master");
    expect(masterCall?.[0]?.port).toBe(2222);
    expect(masterCall?.[0]?.domain).toBe("local");
    expect(masterCall?.[0]?.hostname).toBe("test-host");
    expect((masterCall?.[0]?.txt as Record<string, string>)?.lanHost).toBe(
      "test-host.local",
    );
    expect((masterCall?.[0]?.txt as Record<string, string>)?.sshPort).toBe(
      "2222",
    );

    expect(bridgeCall?.[0]?.type).toBe("clawdis-bridge");
    expect(bridgeCall?.[0]?.port).toBe(18790);
    expect(bridgeCall?.[0]?.domain).toBe("local");
    expect(bridgeCall?.[0]?.hostname).toBe("test-host");
    expect((bridgeCall?.[0]?.txt as Record<string, string>)?.bridgePort).toBe(
      "18790",
    );
    expect((bridgeCall?.[0]?.txt as Record<string, string>)?.transport).toBe(
      "bridge",
    );

    // We don't await `advertise()`, but it should still be called for each service.
    expect(advertise).toHaveBeenCalledTimes(2);

    await started.stop();
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("normalizes hostnames with domains for service names", async () => {
    // Allow advertiser to run in unit tests.
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";

    vi.spyOn(os, "hostname").mockReturnValue("Mac.localdomain");

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    createService.mockReturnValue({ advertise, destroy });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
      bridgePort: 18790,
    });

    const [masterCall] = createService.mock.calls as Array<[ServiceCall]>;
    expect(masterCall?.[0]?.name).toBe("Mac (Clawdis)");
    expect(masterCall?.[0]?.domain).toBe("local");
    expect(masterCall?.[0]?.hostname).toBe("Mac");
    expect((masterCall?.[0]?.txt as Record<string, string>)?.lanHost).toBe(
      "Mac.local",
    );

    await started.stop();
  });
});
