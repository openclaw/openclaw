import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import * as tailscale from "./tailscale.js";

const {
  ensureGoInstalled,
  ensureTailscaledInstalled,
  getTailnetHostname,
  getTestTailscaleBinaryOverride,
  resolveTailscaleClient,
  enableTailscaleServe,
  disableTailscaleServe,
  ensureFunnel,
  tailscaleServeStatusCoversPort,
  tailscaleFunnelStatusCoversPort,
  verifyTailscaleServeRoute,
} = tailscale;
const tailscaleBin = expect.stringMatching(/tailscale$/i);

function createTailscaleExec(params?: {
  status?: Record<string, unknown>;
  ip?: string;
  commandResult?: { stdout: string; stderr?: string };
}) {
  const status =
    params?.status ??
    ({
      BackendState: "Running",
      Self: { DNSName: "host.tailnet.ts.net.", TailscaleIPs: ["100.1.1.1"] },
      TailscaleIPs: ["100.1.1.1"],
    } as Record<string, unknown>);
  return vi.fn(async (_cmd: string, args: string[]) => {
    if (args.includes("status") && args.includes("--json")) {
      return { stdout: JSON.stringify(status), stderr: "" };
    }
    if (args.includes("ip") && args.includes("-4")) {
      return { stdout: params?.ip ?? "100.1.1.1\n", stderr: "" };
    }
    return params?.commandResult
      ? { stdout: params.commandResult.stdout, stderr: params.commandResult.stderr ?? "" }
      : { stdout: "", stderr: "" };
  });
}

function createRuntimeWithExitError() {
  return {
    error: vi.fn(),
    log: vi.fn(),
    exit: ((code: number) => {
      throw new Error(`exit ${code}`);
    }) as (code: number) => never,
  };
}

function expectServeFallbackCommand(params: { callArgs: string[]; sudoArgs: string[] }) {
  return [
    [tailscaleBin, expect.arrayContaining(params.callArgs)],
    ["sudo", expect.arrayContaining(["-n", tailscaleBin, ...params.sudoArgs])],
  ];
}

describe("tailscale helpers", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_TEST_TAILSCALE_BINARY", "NODE_ENV", "VITEST"]);
    process.env.OPENCLAW_TEST_TAILSCALE_BINARY = "tailscale";
    process.env.VITEST ??= "true";
  });

  afterEach(() => {
    envSnapshot.restore();
    vi.restoreAllMocks();
  });

  it("parses DNS name from tailscale status", async () => {
    const exec = createTailscaleExec({
      status: {
        BackendState: "Running",
        Self: { DNSName: "host.tailnet.ts.net.", TailscaleIPs: ["100.1.1.1"] },
      },
    });
    const host = await getTailnetHostname(exec);
    expect(host).toBe("host.tailnet.ts.net");
  });

  it("falls back to IP when DNS missing", async () => {
    const exec = createTailscaleExec({
      status: { BackendState: "Running", Self: { TailscaleIPs: ["100.2.2.2"] } },
      ip: "100.2.2.2\n",
    });
    const host = await getTailnetHostname(exec);
    expect(host).toBe("100.2.2.2");
  });

  it("parses noisy JSON output from tailscale status", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes("status")) {
        return {
          stdout:
            'warning: stale state\n{"BackendState":"Running","Self":{"DNSName":"noisy.tailnet.ts.net.","TailscaleIPs":["100.9.9.9"]}}\n',
          stderr: "",
        };
      }
      return { stdout: "100.9.9.9\n", stderr: "" };
    });
    const host = await getTailnetHostname(exec);
    expect(host).toBe("noisy.tailnet.ts.net");
  });

  it("resolves explicit socket before default daemon", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      const socketIndex = args.indexOf("--socket");
      const socket = socketIndex >= 0 ? args[socketIndex + 1] : undefined;
      if (!socket) {
        throw Object.assign(new Error("dial unix /var/run/tailscaled.socket: no such file"), {
          stderr: "dial unix /var/run/tailscaled.socket: no such file",
        });
      }
      if (args.includes("status")) {
        return {
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { DNSName: "userspace.tailnet.ts.net.", TailscaleIPs: ["100.9.9.9"] },
          }),
          stderr: "",
        };
      }
      return { stdout: "100.9.9.9\n", stderr: "" };
    });

    const client = await resolveTailscaleClient(exec as never, { socketPath: "/tmp" });

    expect(client.socketPath).toBe("/tmp");
    expect(client.dnsName).toBe("userspace.tailnet.ts.net");
    expect(exec).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.not.arrayContaining(["--socket"]),
      expect.any(Object),
    );
  });

  it("allows the test binary override in explicit test environments", () => {
    process.env.OPENCLAW_TEST_TAILSCALE_BINARY = "/tmp/test-tailscale";
    process.env.NODE_ENV = "test";
    delete process.env.VITEST;

    expect(getTestTailscaleBinaryOverride()).toBe("/tmp/test-tailscale");
  });

  it("ignores the test binary override outside test environments", () => {
    process.env.OPENCLAW_TEST_TAILSCALE_BINARY = "/tmp/attacker-tailscale";
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;

    expect(getTestTailscaleBinaryOverride()).toBeNull();
  });

  it.each([
    {
      name: "ensureGoInstalled installs when missing and user agrees",
      fn: ensureGoInstalled,
      missingError: new Error("no go"),
      installCommand: ["brew", ["install", "go"]] as const,
      promptResult: true,
    },
    {
      name: "ensureTailscaledInstalled installs when missing and user agrees",
      fn: ensureTailscaledInstalled,
      missingError: new Error("missing"),
      installCommand: ["brew", ["install", "tailscale"]] as const,
      promptResult: true,
    },
  ])("$name", async ({ fn, missingError, installCommand, promptResult }) => {
    const exec = vi.fn().mockRejectedValueOnce(missingError).mockResolvedValue({});
    const prompt = vi.fn().mockResolvedValue(promptResult);
    const runtime = createRuntimeWithExitError();
    await fn(exec as never, prompt, runtime);
    expect(exec).toHaveBeenCalledWith(installCommand[0], installCommand[1]);
  });

  it.each([
    {
      name: "ensureGoInstalled exits when missing and user declines install",
      fn: ensureGoInstalled,
      missingError: new Error("no go"),
      errorMessage: "Go is required to build tailscaled from source. Aborting.",
    },
    {
      name: "ensureTailscaledInstalled exits when missing and user declines install",
      fn: ensureTailscaledInstalled,
      missingError: new Error("missing"),
      errorMessage: "tailscaled is required for user-space funnel. Aborting.",
    },
  ])("$name", async ({ fn, missingError, errorMessage }) => {
    const exec = vi.fn().mockRejectedValueOnce(missingError);
    const prompt = vi.fn().mockResolvedValue(false);
    const runtime = createRuntimeWithExitError();

    await expect(fn(exec as never, prompt, runtime)).rejects.toThrow("exit 1");
    expect(runtime.error).toHaveBeenCalledWith(errorMessage);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("enableTailscaleServe attempts normal first, then sudo", async () => {
    let serveAttempts = 0;
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes("status")) {
        return {
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { TailscaleIPs: ["100.1.1.1"] },
          }),
          stderr: "",
        };
      }
      if (args.includes("ip")) {
        return { stdout: "100.1.1.1\n", stderr: "" };
      }
      if (args.includes("serve")) {
        serveAttempts += 1;
        if (serveAttempts === 1) {
          throw new Error("permission denied");
        }
      }
      return { stdout: "", stderr: "" };
    });

    await enableTailscaleServe(3000, exec as never);

    const [firstCall, secondCall] = expectServeFallbackCommand({
      callArgs: ["serve", "--bg", "--yes", "--https=443", "http://127.0.0.1:3000"],
      sudoArgs: ["serve", "--bg", "--yes", "--https=443", "http://127.0.0.1:3000"],
    });
    expect(exec).toHaveBeenNthCalledWith(3, firstCall[0], firstCall[1], expect.any(Object));
    expect(exec).toHaveBeenNthCalledWith(4, secondCall[0], secondCall[1], expect.any(Object));
  });

  it("enableTailscaleServe does NOT use sudo if first attempt succeeds", async () => {
    const exec = createTailscaleExec();

    await enableTailscaleServe(3000, exec as never);

    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec).toHaveBeenCalledWith(
      tailscaleBin,
      expect.arrayContaining(["serve", "--bg", "--yes", "--https=443", "http://127.0.0.1:3000"]),
      expect.any(Object),
    );
  });

  it("disableTailscaleServe refuses broad reset unless explicitly allowed", async () => {
    const exec = createTailscaleExec();

    await expect(disableTailscaleServe(exec as never)).rejects.toThrow(/Refusing/);
  });

  it("disableTailscaleServe uses fallback when explicitly allowed", async () => {
    let resetAttempts = 0;
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes("status")) {
        return {
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { TailscaleIPs: ["100.1.1.1"] },
          }),
          stderr: "",
        };
      }
      if (args.includes("ip")) {
        return { stdout: "100.1.1.1\n", stderr: "" };
      }
      if (args.includes("reset")) {
        resetAttempts += 1;
        if (resetAttempts === 1) {
          throw new Error("permission denied");
        }
      }
      return { stdout: "", stderr: "" };
    });

    await disableTailscaleServe(exec as never, { allowUnsafeServeReset: true });

    expect(exec).toHaveBeenCalledTimes(4);
    expect(exec).toHaveBeenNthCalledWith(
      4,
      "sudo",
      expect.arrayContaining(["-n", tailscaleBin, "serve", "reset"]),
      expect.any(Object),
    );
  });

  it("ensureFunnel uses fallback for enabling", async () => {
    let enableAttempts = 0;
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes("status") && args.includes("--json") && !args.includes("funnel")) {
        return {
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { TailscaleIPs: ["100.1.1.1"] },
          }),
          stderr: "",
        };
      }
      if (args.includes("ip")) {
        return { stdout: "100.1.1.1\n", stderr: "" };
      }
      if (args.includes("funnel") && args.includes("status")) {
        return { stdout: JSON.stringify({ BackendState: "Running" }), stderr: "" };
      }
      if (args.includes("funnel")) {
        enableAttempts += 1;
        if (enableAttempts === 1) {
          throw new Error("permission denied");
        }
      }
      return { stdout: "", stderr: "" };
    });

    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: vi.fn() as unknown as (code: number) => never,
    };
    const prompt = vi.fn();

    await ensureFunnel(8080, exec as never, runtime, prompt);

    expect(exec).toHaveBeenNthCalledWith(
      3,
      tailscaleBin,
      expect.arrayContaining(["funnel", "status", "--json"]),
    );
    expect(exec).toHaveBeenNthCalledWith(
      4,
      tailscaleBin,
      expect.arrayContaining(["funnel", "--yes", "--bg", "8080"]),
      expect.any(Object),
    );
    expect(exec).toHaveBeenNthCalledWith(
      5,
      "sudo",
      expect.arrayContaining(["-n", tailscaleBin, "funnel", "--yes", "--bg", "8080"]),
      expect.any(Object),
    );
  });

  it("enableTailscaleServe skips sudo on non-permission errors", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes("status")) {
        return {
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { TailscaleIPs: ["100.1.1.1"] },
          }),
          stderr: "",
        };
      }
      if (args.includes("ip")) {
        return { stdout: "100.1.1.1\n", stderr: "" };
      }
      throw new Error("boom");
    });

    await expect(enableTailscaleServe(3000, exec as never)).rejects.toThrow("boom");

    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("enableTailscaleServe rethrows original error if sudo fails", async () => {
    const originalError = Object.assign(new Error("permission denied"), {
      stderr: "permission denied",
    });
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes("status")) {
        return {
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { TailscaleIPs: ["100.1.1.1"] },
          }),
          stderr: "",
        };
      }
      if (args.includes("ip")) {
        return { stdout: "100.1.1.1\n", stderr: "" };
      }
      if (_cmd === "sudo") {
        throw new Error("sudo: a password is required");
      }
      throw originalError;
    });

    await expect(enableTailscaleServe(3000, exec as never)).rejects.toBe(originalError);

    expect(exec).toHaveBeenCalledTimes(4);
  });
});

describe("tailscaleFunnelStatusCoversPort", () => {
  function buildFunnelStatus(handlers: Record<string, { Proxy?: unknown }>) {
    const host = "device.tailnet.ts.net:443";
    return {
      AllowFunnel: { [host]: true },
      Web: {
        [host]: { Handlers: handlers },
      },
    } as Record<string, unknown>;
  }

  it("matches a Funnel route whose Proxy is a full http URL", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://127.0.0.1:18789" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches a Proxy URL with a trailing slash", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://127.0.0.1:18789/" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches a Proxy URL with a longer path", () => {
    const status = buildFunnelStatus({ "/api": { Proxy: "http://127.0.0.1:18789/api" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches the localhost loopback alias", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://localhost:18789" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches an IPv6 loopback Proxy", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://[::1]:18789" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches the documented https+insecure target scheme", () => {
    const status = buildFunnelStatus({
      "/": { Proxy: "https+insecure://localhost:18789" },
    });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches https+insecure with a trailing path", () => {
    const status = buildFunnelStatus({
      "/api": { Proxy: "https+insecure://127.0.0.1:18789/api" },
    });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("does not match https+insecure on a non-loopback host", () => {
    const status = buildFunnelStatus({
      "/": { Proxy: "https+insecure://10.0.0.5:18789" },
    });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(false);
  });

  it("matches a bare port form", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "18789" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("does not match a Proxy on a different port", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://127.0.0.1:9000" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(false);
  });

  it("does not match a non-loopback host on the right port", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://10.0.0.5:18789" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(false);
  });

  it("ignores Web entries whose host is not in AllowFunnel", () => {
    const status = {
      AllowFunnel: { "device.tailnet.ts.net:443": false },
      Web: {
        "device.tailnet.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } },
        },
      },
    } as Record<string, unknown>;
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(false);
  });

  it("returns false on an empty status payload", () => {
    expect(tailscaleFunnelStatusCoversPort({}, 18789)).toBe(false);
  });
});

describe("tailscaleServeStatusCoversPort", () => {
  it("matches Serve handlers that point at the gateway port", () => {
    const status = {
      Web: {
        "host.tailnet.ts.net:443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:18789" },
          },
        },
      },
    } as Record<string, unknown>;

    expect(tailscaleServeStatusCoversPort(status, 18789)).toBe(true);
    expect(tailscaleServeStatusCoversPort(status, 3000)).toBe(false);
  });

  it("strictly verifies host, HTTPS 443, root path, and backend", () => {
    const status = {
      Web: {
        "host.tailnet.ts.net:443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:18789" },
          },
        },
      },
    } as Record<string, unknown>;

    expect(
      verifyTailscaleServeRoute(status, {
        host: "host.tailnet.ts.net.",
        port: 18789,
        path: "/",
      }),
    ).toMatchObject({
      ok: true,
      routeKey: "host.tailnet.ts.net:443",
      proxy: "http://127.0.0.1:18789",
    });
    expect(
      verifyTailscaleServeRoute(status, {
        host: "old.tailnet.ts.net",
        port: 18789,
        path: "/",
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("old.tailnet.ts.net") });
    expect(
      verifyTailscaleServeRoute(status, {
        host: "host.tailnet.ts.net",
        port: 3000,
        path: "/",
      }),
    ).toMatchObject({ ok: false, proxy: "http://127.0.0.1:18789" });
  });
});
