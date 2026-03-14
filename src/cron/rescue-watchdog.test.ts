import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.hoisted(() =>
  vi.fn<
    () => {
      gateway: {
        port: number;
        bind: string;
        customBindHost?: string;
        tls?: { enabled?: boolean };
        auth: {
          mode: string;
          token: string;
        };
      };
    }
  >(() => ({
    gateway: {
      port: 18_789,
      bind: "loopback",
      auth: {
        mode: "token",
        token: "main-token",
      },
    },
  })),
);
const restartService = vi.hoisted(() => vi.fn(async () => {}));
const readServiceCommand = vi.hoisted(() =>
  vi.fn<
    () => Promise<{
      programArguments: string[];
      environment?: Record<string, string>;
    } | null>
  >(async () => null),
);
const probeGateway = vi.hoisted(() => vi.fn());
const resolveGatewayProbeAuthSafe = vi.hoisted(() =>
  vi.fn(() => ({
    auth: { token: "main-token" },
  })),
);
const runCommandWithTimeout = vi.hoisted(() =>
  vi.fn(async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as const,
    noOutputTimedOut: false,
  })),
);
const resolveGatewayBindHost = vi.hoisted(() =>
  vi.fn(async (bind: string | undefined, customHost?: string): Promise<string> => {
    if (bind === "custom") {
      return customHost?.trim() || "0.0.0.0";
    }
    if (bind === "tailnet") {
      return "100.64.0.10";
    }
    return "127.0.0.1";
  }),
);

vi.mock("../config/io.js", () => ({
  createConfigIO: vi.fn(() => ({
    loadConfig,
  })),
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: vi.fn(() => ({
    restart: restartService,
    readCommand: readServiceCommand,
  })),
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway,
}));

vi.mock("../gateway/probe-auth.js", () => ({
  resolveGatewayProbeAuthSafe,
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout,
}));
vi.mock("../gateway/net.js", () => ({
  resolveGatewayBindHost,
}));

import { runRescueWatchdogJob } from "./rescue-watchdog.js";

describe("runRescueWatchdogJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));
    loadConfig.mockClear();
    restartService.mockClear();
    readServiceCommand.mockReset();
    readServiceCommand.mockResolvedValue(null);
    probeGateway.mockReset();
    resolveGatewayProbeAuthSafe.mockClear();
    resolveGatewayBindHost.mockClear();
    runCommandWithTimeout.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns without repair when the monitored gateway is already healthy", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      error: null,
    });

    const result = await runRescueWatchdogJob({
      job: {
        id: "job-1",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "default",
          timeoutSeconds: 120,
        },
      } as never,
      monitoredProfile: "default",
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("found it healthy");
    expect(restartService).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("probes the monitored service port override from the installed daemon env", async () => {
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      OPENCLAW_PROFILE: "rescue",
      OPENCLAW_GATEWAY_PORT: "29998",
    };
    readServiceCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {
        OPENCLAW_GATEWAY_PORT: "19001",
      },
    });
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      error: null,
    });

    try {
      const result = await runRescueWatchdogJob({
        job: {
          id: "job-managed-port-override",
          name: "rescue",
          payload: {
            kind: "rescueWatchdog",
            monitoredProfile: "work",
            timeoutSeconds: 120,
          },
        } as never,
        monitoredProfile: "work",
      });

      expect(result.status).toBe("ok");
      expect(readServiceCommand).toHaveBeenCalledWith(
        expect.not.objectContaining({
          OPENCLAW_GATEWAY_PORT: "29998",
        }),
      );
      expect(probeGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "ws://127.0.0.1:19001",
        }),
      );
      expect(restartService).not.toHaveBeenCalled();
    } finally {
      process.env = originalEnv;
    }
  });

  it("probes with the configured scheme and custom bind host", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        port: 18_789,
        bind: "custom",
        customBindHost: "gateway.internal",
        tls: { enabled: true },
        auth: {
          mode: "token",
          token: "main-token",
        },
      },
    });
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      error: null,
    });

    const result = await runRescueWatchdogJob({
      job: {
        id: "job-custom-bind",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "work",
          timeoutSeconds: 120,
        },
      } as never,
      monitoredProfile: "work",
    });

    expect(result.status).toBe("ok");
    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        disableDeviceIdentity: true,
        url: "wss://gateway.internal:18789",
      }),
    );
  });

  it("brackets IPv6 custom bind hosts in the watchdog probe URL", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        port: 18_789,
        bind: "custom",
        customBindHost: "::1",
        auth: {
          mode: "token",
          token: "main-token",
        },
      },
    });
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      error: null,
    });

    const result = await runRescueWatchdogJob({
      job: {
        id: "job-custom-ipv6",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "work",
          timeoutSeconds: 120,
        },
      } as never,
      monitoredProfile: "work",
    });

    expect(result.status).toBe("ok");
    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        disableDeviceIdentity: true,
        url: "ws://[::1]:18789",
      }),
    );
  });

  it("probes loopback when custom bind host falls back to wildcard listen", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        port: 18_789,
        bind: "custom",
        customBindHost: "192.168.10.77",
        auth: {
          mode: "token",
          token: "main-token",
        },
      },
    });
    resolveGatewayBindHost.mockResolvedValueOnce("0.0.0.0");
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      error: null,
    });

    const result = await runRescueWatchdogJob({
      job: {
        id: "job-custom-fallback",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "work",
          timeoutSeconds: 120,
        },
      } as never,
      monitoredProfile: "work",
    });

    expect(result.status).toBe("ok");
    expect(resolveGatewayBindHost).toHaveBeenCalledWith("custom", "192.168.10.77");
    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        disableDeviceIdentity: true,
        url: "ws://127.0.0.1:18789",
      }),
    );
  });

  it("disables device identity even when probing a non-loopback monitored host", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        port: 18_789,
        bind: "tailnet",
        auth: {
          mode: "token",
          token: "main-token",
        },
      },
    });
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      error: null,
    });

    const result = await runRescueWatchdogJob({
      job: {
        id: "job-tailnet-bind",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "work",
          timeoutSeconds: 120,
        },
      } as never,
      monitoredProfile: "work",
    });

    expect(result.status).toBe("ok");
    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        disableDeviceIdentity: true,
        url: "ws://100.64.0.10:18789",
      }),
    );
  });

  it("rejects rescue-shaped monitored profiles before service actions", async () => {
    const result = await runRescueWatchdogJob({
      job: {
        id: "job-rescue-profile",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "rescue",
          timeoutSeconds: 120,
        },
      } as never,
      monitoredProfile: "rescue",
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("cannot monitor rescue profiles");
    expect(restartService).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("restarts the managed service before escalating to doctor", async () => {
    probeGateway
      .mockResolvedValueOnce({
        ok: false,
        close: { code: 1006, reason: "down" },
        error: "down",
      })
      .mockResolvedValueOnce({
        ok: true,
        close: null,
        error: null,
      });

    const result = await runRescueWatchdogJob({
      job: {
        id: "job-2",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "work",
          timeoutSeconds: 120,
        },
      } as never,
      monitoredProfile: "work",
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("restarted managed gateway service");
    expect(restartService).toHaveBeenCalledTimes(1);
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("falls back to doctor with a fixed argv when restart does not recover the gateway", async () => {
    let probeCount = 0;
    probeGateway.mockImplementation(async () => {
      probeCount += 1;
      if (probeCount >= 62) {
        return {
          ok: true,
          close: null,
          error: null,
        };
      }
      return {
        ok: false,
        close: { code: 1006, reason: "down" },
        error: "down",
      };
    });

    const runPromise = runRescueWatchdogJob({
      job: {
        id: "job-3",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "work",
          timeoutSeconds: 120,
        },
      } as never,
      monitoredProfile: "work",
    });

    await vi.advanceTimersByTimeAsync(31_000);
    const result = await runPromise;

    expect(result.status).toBe("ok");
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      expect.arrayContaining(["--profile", "work", "doctor", "--repair", "--non-interactive"]),
      expect.objectContaining({
        timeoutMs: expect.any(Number),
      }),
    );
    expect(result.summary).toContain("ran doctor --repair --non-interactive");
  });

  it("passes the job abort signal into the doctor fallback subprocess", async () => {
    let probeCount = 0;
    probeGateway.mockImplementation(async () => {
      probeCount += 1;
      if (probeCount >= 62) {
        return {
          ok: true,
          close: null,
          error: null,
        };
      }
      return {
        ok: false,
        close: { code: 1006, reason: "down" },
        error: "down",
      };
    });

    const abort = new AbortController();
    const runPromise = runRescueWatchdogJob({
      job: {
        id: "job-doctor-abort-signal",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "work",
          timeoutSeconds: 120,
        },
      } as never,
      monitoredProfile: "work",
      abortSignal: abort.signal,
    });

    await vi.advanceTimersByTimeAsync(31_000);
    const result = await runPromise;

    expect(result.status).toBe("ok");
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      expect.arrayContaining(["--profile", "work", "doctor", "--repair", "--non-interactive"]),
      expect.objectContaining({
        baseEnv: {},
        signal: abort.signal,
        timeoutMs: expect.any(Number),
      }),
    );
  });

  it("runs doctor with the rescue profile env only, without inheriting parent service identity", async () => {
    const inheritedEnv = {
      OPENCLAW_PROFILE: "rescue",
      OPENCLAW_LAUNCHD_LABEL: "com.example.openclaw-rescue",
      OPENCLAW_GATEWAY_PORT: "29998",
      PATH: "/tmp/bin",
      HOME: "/home/tester",
    };
    const originalEnv = process.env;
    process.env = { ...originalEnv, ...inheritedEnv };

    try {
      let probeCount = 0;
      probeGateway.mockImplementation(async () => {
        probeCount += 1;
        if (probeCount >= 62) {
          return {
            ok: true,
            close: null,
            error: null,
          };
        }
        return {
          ok: false,
          close: { code: 1006, reason: "down" },
          error: "down",
        };
      });

      const runPromise = runRescueWatchdogJob({
        job: {
          id: "job-doctor-env-isolated",
          name: "rescue",
          payload: {
            kind: "rescueWatchdog",
            monitoredProfile: "work",
            timeoutSeconds: 120,
          },
        } as never,
        monitoredProfile: "work",
      });

      await vi.advanceTimersByTimeAsync(31_000);
      await runPromise;

      expect(runCommandWithTimeout).toHaveBeenCalledWith(
        expect.arrayContaining(["--profile", "work", "doctor", "--repair", "--non-interactive"]),
        expect.objectContaining({
          baseEnv: {},
          env: expect.objectContaining({
            OPENCLAW_PROFILE: "work",
            PATH: "/tmp/bin",
          }),
        }),
      );

      const doctorOptions = (
        (runCommandWithTimeout.mock.lastCall ?? [undefined, undefined]) as unknown as [
          unknown,
          { env?: Record<string, string | undefined> } | undefined,
        ]
      )[1];
      expect(doctorOptions?.env?.OPENCLAW_LAUNCHD_LABEL).toBeUndefined();
      expect(doctorOptions?.env?.OPENCLAW_GATEWAY_PORT).toBeUndefined();
    } finally {
      process.env = originalEnv;
    }
  });
  it("skips doctor when the cron timeout budget is already exhausted", async () => {
    probeGateway.mockResolvedValue({
      ok: false,
      close: { code: 1006, reason: "down" },
      error: "down",
    });

    const runPromise = runRescueWatchdogJob({
      job: {
        id: "job-4",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "work",
          timeoutSeconds: 5,
        },
      } as never,
      monitoredProfile: "work",
    });

    await vi.advanceTimersByTimeAsync(31_000);
    const result = await runPromise;

    expect(result.status).toBe("error");
    expect(result.error).toContain("skipped doctor fallback");
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("bounds service restart by timeout budget", async () => {
    probeGateway.mockResolvedValue({
      ok: false,
      close: { code: 1006, reason: "down" },
      error: "down",
    });
    restartService.mockImplementation(() => new Promise<void>(() => {}));

    const runPromise = runRescueWatchdogJob({
      job: {
        id: "job-restart-timeout",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "work",
          timeoutSeconds: 45,
        },
      } as never,
      monitoredProfile: "work",
    });

    await vi.advanceTimersByTimeAsync(46_000);
    const result = await runPromise;

    expect(result.status).toBe("error");
    expect(result.error).toContain("restart failed: service restart timed out");
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("returns quickly when aborted during service restart", async () => {
    probeGateway.mockResolvedValue({
      ok: false,
      close: { code: 1006, reason: "down" },
      error: "down",
    });
    restartService.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 60_000);
        }),
    );
    const abort = new AbortController();

    const runPromise = runRescueWatchdogJob({
      job: {
        id: "job-restart-abort",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "work",
          timeoutSeconds: 120,
        },
      } as never,
      monitoredProfile: "work",
      abortSignal: abort.signal,
    });
    abort.abort();
    await vi.advanceTimersByTimeAsync(1);
    const result = await runPromise;

    expect(result.status).toBe("error");
    expect(result.error).toContain("service restart aborted");
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("clips post-repair probe wait to the remaining timeout budget", async () => {
    probeGateway.mockResolvedValue({
      ok: false,
      close: { code: 1006, reason: "down" },
      error: "down",
    });
    restartService.mockImplementation(() => new Promise<void>(() => {}));

    let settled = false;
    const runPromise = runRescueWatchdogJob({
      job: {
        id: "job-post-repair-probe-budget",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "work",
          timeoutSeconds: 47,
        },
      } as never,
      monitoredProfile: "work",
    }).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(52_000);
    expect(settled).toBe(true);
    const result = await runPromise;

    expect(result.status).toBe("error");
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("caps per-probe timeout to the remaining probe budget", async () => {
    probeGateway.mockResolvedValue({
      ok: false,
      close: { code: 1006, reason: "down" },
      error: "down",
    });
    restartService.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 700);
        }),
    );

    const runPromise = runRescueWatchdogJob({
      job: {
        id: "job-probe-timeout-budget",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "work",
          timeoutSeconds: 1,
        },
      } as never,
      monitoredProfile: "work",
    });

    await vi.advanceTimersByTimeAsync(2_000);
    const result = await runPromise;

    expect(result.status).toBe("error");
    expect(probeGateway).toHaveBeenCalled();
    const probeTimeouts = probeGateway.mock.calls
      .map((call) => (call[0] as { timeoutMs?: number } | undefined)?.timeoutMs)
      .filter((timeoutMs): timeoutMs is number => typeof timeoutMs === "number");
    expect(probeTimeouts.length).toBeGreaterThan(0);
    expect(Math.min(...probeTimeouts)).toBeGreaterThan(0);
    expect(probeTimeouts.some((timeoutMs) => timeoutMs <= 1_000)).toBe(true);
  });
});
