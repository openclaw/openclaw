import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeGatewayTokenInput,
  openUrl,
  resolveGatewayModeProbeSummary,
  resolveBrowserOpenCommand,
  resolveControlUiLinks,
  validateGatewayPasswordInput,
} from "./onboard-helpers.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(async () => ({})),
  runCommandWithTimeout: vi.fn<
    (
      argv: string[],
      options?: { timeoutMs?: number; windowsVerbatimArguments?: boolean },
    ) => Promise<{ stdout: string; stderr: string; code: number; signal: null; killed: boolean }>
  >(async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
  })),
  pickPrimaryTailnetIPv4: vi.fn<() => string | undefined>(() => undefined),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: mocks.pickPrimaryTailnetIPv4,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.callGateway.mockReset();
  mocks.callGateway.mockResolvedValue({});
  mocks.pickPrimaryTailnetIPv4.mockReset();
  mocks.pickPrimaryTailnetIPv4.mockReturnValue(undefined);
});

describe("openUrl", () => {
  it("quotes URLs on win32 so '&' is not treated as cmd separator", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "");
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");

    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&response_type=code&redirect_uri=http%3A%2F%2Flocalhost";

    const ok = await openUrl(url);
    expect(ok).toBe(true);

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(1);
    const [argv, options] = mocks.runCommandWithTimeout.mock.calls[0] ?? [];
    expect(argv?.slice(0, 4)).toEqual(["cmd", "/c", "start", '""']);
    expect(argv?.at(-1)).toBe(`"${url}"`);
    expect(options).toMatchObject({
      timeoutMs: 5_000,
      windowsVerbatimArguments: true,
    });

    platformSpy.mockRestore();
  });
});

describe("resolveBrowserOpenCommand", () => {
  it("marks win32 commands as quoteUrl=true", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const resolved = await resolveBrowserOpenCommand();
    expect(resolved.argv).toEqual(["cmd", "/c", "start", ""]);
    expect(resolved.quoteUrl).toBe(true);
    platformSpy.mockRestore();
  });
});

describe("resolveControlUiLinks", () => {
  it("uses customBindHost for custom bind", () => {
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "custom",
      customBindHost: "192.168.1.100",
    });
    expect(links.httpUrl).toBe("http://192.168.1.100:18789/");
    expect(links.wsUrl).toBe("ws://192.168.1.100:18789");
  });

  it("falls back to loopback for invalid customBindHost", () => {
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "custom",
      customBindHost: "192.168.001.100",
    });
    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
  });

  it("uses tailnet IP for tailnet bind", () => {
    mocks.pickPrimaryTailnetIPv4.mockReturnValueOnce("100.64.0.9");
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "tailnet",
    });
    expect(links.httpUrl).toBe("http://100.64.0.9:18789/");
    expect(links.wsUrl).toBe("ws://100.64.0.9:18789");
  });

  it("keeps loopback for auto even when tailnet is present", () => {
    mocks.pickPrimaryTailnetIPv4.mockReturnValueOnce("100.64.0.9");
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "auto",
    });
    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
  });
});

describe("resolveGatewayModeProbeSummary", () => {
  it("uses the configured local port and env-first credential precedence", async () => {
    mocks.callGateway.mockImplementation(async ({ url }: { url: string }) => {
      if (url === "ws://127.0.0.1:24567") {
        return {};
      }
      throw new Error("remote down");
    });

    const summary = await resolveGatewayModeProbeSummary({
      cfg: {
        gateway: {
          auth: {
            token: "config-token",
            password: "config-password",
          },
          remote: {
            url: "wss://remote.example",
            token: "config-remote-token",
          },
        },
      },
      localPort: 24567,
      env: {
        ...process.env,
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      },
      resolveSecretInput: async ({ path }) => {
        if (path === "gateway.auth.token") {
          return "resolved-token";
        }
        if (path === "gateway.auth.password") {
          return "resolved-password";
        }
        if (path === "gateway.remote.token") {
          return "resolved-remote-token";
        }
        return undefined;
      },
    });

    expect(summary.localUrl).toBe("ws://127.0.0.1:24567");
    expect(summary.credentials.localToken).toBe("env-token");
    expect(summary.credentials.localPassword).toBe("resolved-password");
    expect(summary.credentials.remoteToken).toBe("resolved-remote-token");
    expect(summary.hints.local).toBe("Gateway reachable (ws://127.0.0.1:24567)");
    expect(summary.hints.remote).toBe("Configured but unreachable (wss://remote.example)");
    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "ws://127.0.0.1:24567",
        token: "env-token",
        password: "resolved-password",
      }),
    );
  });

  it("reports secret resolution failures and falls back to direct config values", async () => {
    const onSecretResolveError = vi.fn();
    mocks.callGateway.mockResolvedValue({});

    const summary = await resolveGatewayModeProbeSummary({
      cfg: {
        gateway: {
          auth: {
            token: " direct-token ",
          },
          remote: {
            url: "wss://remote.example",
            token: " direct-remote-token ",
          },
        },
      },
      localPort: 18789,
      resolveSecretInput: async ({ path }) => {
        if (path === "gateway.auth.token") {
          throw new Error("missing env ref");
        }
        return undefined;
      },
      onSecretResolveError,
    });

    expect(onSecretResolveError).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "gateway.auth.token",
      }),
    );
    expect(summary.credentials.localToken).toBe("direct-token");
    expect(summary.credentials.remoteToken).toBe("direct-remote-token");
  });
});

describe("normalizeGatewayTokenInput", () => {
  it("returns empty string for undefined or null", () => {
    expect(normalizeGatewayTokenInput(undefined)).toBe("");
    expect(normalizeGatewayTokenInput(null)).toBe("");
  });

  it("trims string input", () => {
    expect(normalizeGatewayTokenInput("  token  ")).toBe("token");
  });

  it("returns empty string for non-string input", () => {
    expect(normalizeGatewayTokenInput(123)).toBe("");
  });

  it('rejects literal string coercion artifacts ("undefined"/"null")', () => {
    expect(normalizeGatewayTokenInput("undefined")).toBe("");
    expect(normalizeGatewayTokenInput("null")).toBe("");
  });
});

describe("validateGatewayPasswordInput", () => {
  it("requires a non-empty password", () => {
    expect(validateGatewayPasswordInput("")).toBe("Required");
    expect(validateGatewayPasswordInput("   ")).toBe("Required");
  });

  it("rejects literal string coercion artifacts", () => {
    expect(validateGatewayPasswordInput("undefined")).toBe(
      'Cannot be the literal string "undefined" or "null"',
    );
    expect(validateGatewayPasswordInput("null")).toBe(
      'Cannot be the literal string "undefined" or "null"',
    );
  });

  it("accepts a normal password", () => {
    expect(validateGatewayPasswordInput(" secret ")).toBeUndefined();
  });
});
