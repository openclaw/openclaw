import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayStoredDeviceAuthUnavailableError, GatewayTransportError } from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return { ...actual, callGateway: callGatewayMock };
});

import {
  parseBareSessionInvocation,
  parseSessionTargetInput,
  SessionTargetParseError,
} from "./session-ref.js";
import { resolveSessionTarget } from "./session-target.js";

function gatewayTransportError(params: {
  url: string;
  message: string;
  reason?: string;
  kind?: "closed" | "timeout";
}): GatewayTransportError {
  return new GatewayTransportError({
    kind: params.kind ?? "closed",
    message: params.message,
    reason: params.reason,
    connectionDetails: {
      url: params.url,
      urlSource: "cli --url",
      message: `Gateway target: ${params.url}`,
    },
  });
}

describe("session target parsing", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    delete process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS;
  });

  it.each([
    {
      input: "wss://gateway.example/base/chat/ops/telegram/123?view=compact#messages",
      expected: {
        kind: "url",
        origin: "wss://gateway.example",
        basePath: "/base",
        agentId: "ops",
        ref: { kind: "literal", sessionKey: "agent:ops:telegram:123" },
      },
    },
    {
      input: "Gateway.Example/Ops/movies-A1166B81/",
      expected: {
        kind: "url",
        origin: "wss://gateway.example",
        basePath: "",
        agentId: "ops",
        ref: { kind: "short", shortId: "a1166b81", slugHint: "movies" },
      },
    },
  ])("parses $input", ({ input, expected }) => {
    expect(parseSessionTargetInput(input)).toEqual(expected);
  });

  it.each([
    "",
    "not-a-session",
    "https://gateway.example/DASHBOARD/main/deadbeef",
    "ftp://gateway.example/dashboard/main/deadbeef",
  ])("rejects %j with the typed accepted-forms error", (input) => {
    expect(() => parseSessionTargetInput(input)).toThrow(SessionTargetParseError);
    expect(() => parseSessionTargetInput(input)).toThrow("Accepted session targets:");
  });

  it("rejects credentials without echoing them", () => {
    const secret = "do-not-print-me";
    let error: unknown;
    try {
      parseSessionTargetInput(
        `https://user:${secret}@gateway.example/dashboard/main/movies-a1166b81`,
      );
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("must not contain credentials");
    expect(String(error)).not.toContain(secret);
  });

  it("rejects credential query and fragment parameters without echoing them", () => {
    for (const suffix of ["?token=do-not-print-me", "#password=do-not-print-me"]) {
      let error: unknown;
      try {
        parseSessionTargetInput(`https://gateway.example/dashboard/main/movies-a1166b81${suffix}`);
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toContain("must not contain credentials");
      expect(String(error)).not.toContain("do-not-print-me");
    }
  });

  it("surfaces the canonical plaintext WebSocket security gate", () => {
    expect(() =>
      parseSessionTargetInput("ws://gateway.example/dashboard/main/movies-a1166b81"),
    ).toThrow("SECURITY ERROR: Gateway URL");
  });
});

describe("bare-root session URL options", () => {
  const target = "https://gateway.example/dashboard/main/movies-a1166b81";
  const argv = (...args: string[]) => ["node", "openclaw", ...args];

  it.each([["--message", "message", "https://example.com/article"]] as const)(
    "parses %s (%s=%s) before and after the URL",
    (flag, key, value) => {
      for (const args of [
        [flag, value, target],
        [`${flag}=${value}`, target],
        [target, flag, value],
        [target, `${flag}=${value}`],
      ]) {
        expect(parseBareSessionInvocation(argv(...args))).toEqual({
          target,
          options: { [key]: value },
        });
      }
    },
  );

  it("parses boolean options on either side and preserves root globals", () => {
    expect(
      parseBareSessionInvocation(
        argv(
          "--no-color",
          "--profile",
          "work",
          "--deliver",
          target,
          "--log-level=debug",
          "--token=direct-token",
        ),
      ),
    ).toEqual({ target, options: { deliver: true, token: "direct-token" } });
    expect(parseBareSessionInvocation(argv(target, "--deliver"))).toEqual({
      target,
      options: { deliver: true },
    });
  });

  it.each([["host shorthand", ["gateway.example/main/a1166b81"]]])(
    "does not claim %s",
    (_label, args) => {
      expect(parseBareSessionInvocation(argv(...args))).toBeNull();
    },
  );

  it.each(["unowned-command"])(
    "leaves an explicit %s command's URL argument to its owner",
    (command) => {
      expect(parseBareSessionInvocation(argv(command, target))).toBeNull();
    },
  );

  it.each([
    ["split before", ["--token", target]],
    ["split after", [target, "--token"]],
  ])("rejects a missing value %s", (_label, args) => {
    expect(() => parseBareSessionInvocation(argv(...args))).toThrow("--token requires a value");
  });

  it.each([["inline after", [target, "--typo=do-not-print-me"]]])(
    "rejects an unknown option %s without reflecting its value",
    (_label, args) => {
      let error: unknown;
      try {
        parseBareSessionInvocation(argv(...args));
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toContain("Unsupported bare session URL option: --typo");
      expect(String(error)).not.toContain("do-not-print-me");
    },
  );

  it.each([
    ["terminator after", [target, "--"], "Unsupported bare session URL option: --"],
    ["extra after", [target, "do-not-print-me"], "Unexpected extra argument"],
  ])("rejects %s without reflecting extra values", (_label, args, expected) => {
    let error: unknown;
    try {
      parseBareSessionInvocation(argv(...args));
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain(expected);
    expect(String(error)).not.toContain("do-not-print-me");
    expect(String(error)).not.toContain("secret.example");
  });
});

describe("session target resolution", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("resolves a stale-agent URL short reference without scoping UUID lookup", async () => {
    callGatewayMock.mockResolvedValue({ ok: true, key: "agent:research:thread:full-key" });

    const result = await resolveSessionTarget({
      raw: "https://gateway.example/base/dashboard/ops/movies-a1166b81",
      gateway: { token: "explicit-token" },
    });

    expect(result.sessionKey).toBe("agent:research:thread:full-key");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://gateway.example/base",
        token: "explicit-token",
        method: "sessions.resolve",
        params: { shortId: "a1166b81", slugHint: "movies" },
        useStoredDeviceAuth: true,
        requiredStoredDeviceAuthScopes: ["operator.read"],
      }),
    );
  });

  it("uses gateway-advertised routing for URL main sessions without requiring an existing row", async () => {
    callGatewayMock.mockResolvedValue({
      defaultId: "main",
      mainKey: "workspace",
      scope: "per-sender",
      agents: [],
    });

    const result = await resolveSessionTarget({
      raw: "https://gateway.example/dashboard/ops",
    });

    expect(result.sessionKey).toBe("agent:ops:workspace");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://gateway.example",
        method: "agents.list",
        params: {},
        requiredStoredDeviceAuthScopes: ["operator.read"],
      }),
    );
  });

  it.each([
    { key: "agent:ops:main", agentId: "other" },
    { key: "global", agentId: undefined },
  ])("rejects inconsistent resolved ownership $key/$agentId", async (result) => {
    callGatewayMock.mockResolvedValue({ ok: true, ...result });

    await expect(resolveSessionTarget({ raw: "agent:ops:main" })).rejects.toThrow(
      "Gateway returned a session without a consistent agent identity",
    );
  });

  it("retains a Gateway-resolved legacy main owner without reinterpreting the request", async () => {
    callGatewayMock.mockResolvedValue({ ok: true, key: "global", agentId: "ops" });

    await expect(resolveSessionTarget({ raw: "agent:main:main" })).resolves.toMatchObject({
      sessionKey: "global",
      agentId: "ops",
    });
  });

  it("rejects a second explicit URL", async () => {
    await expect(
      resolveSessionTarget({
        raw: "https://gateway.example/dashboard/main/movies-a1166b81",
        gateway: { url: "wss://other.example" },
      }),
    ).rejects.toThrow("pass one target");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("prints bounded ambiguity candidates without listing or describing", async () => {
    callGatewayMock.mockResolvedValue({
      ok: false,
      candidates: [
        {
          key: "agent:main:thread:12345678-0aaa-4000-8000-000000000001",
          displayName: "Alpha",
        },
        {
          key: "agent:main:thread:12345678-0bbb-4000-8000-000000000002",
          displayName: "Beta",
        },
      ],
    });

    await expect(resolveSessionTarget({ raw: "12345678" })).rejects.toThrow(
      /Alpha\s+123456780aaa4000[\s\S]*Beta\s+123456780bbb4000/u,
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("reports old gateways without falling back to sessions.list", async () => {
    callGatewayMock.mockRejectedValue(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "invalid sessions.resolve params: at root: unexpected property 'shortId'",
      }),
    );

    await expect(
      resolveSessionTarget({
        raw: "movies-a1166b81",
        gateway: { url: "wss://gateway.example" },
      }),
    ).rejects.toThrow(
      "This gateway predates short-link resolution; pass the full session key. Choose a full session key from that gateway's Control UI (https://gateway.example).",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("sends remote not-found recovery to the target Control UI, not the local session store", async () => {
    callGatewayMock.mockRejectedValue(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "No session found: a1166b81",
      }),
    );

    let error: unknown;
    try {
      await resolveSessionTarget({ raw: "gateway.example/main/a1166b81" });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("that gateway's Control UI (https://gateway.example)");
    expect(String(error)).not.toContain("sessions list --url");
  });

  it("turns structured pairing and revoked-token failures into actions", async () => {
    callGatewayMock.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "connect failed",
        details: { code: "PAIRING_REQUIRED" },
      }),
    );
    await expect(resolveSessionTarget({ raw: "gateway.example/main/a1166b81" })).rejects.toThrow(
      "openclaw devices approve --latest",
    );

    callGatewayMock.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "connect failed",
        details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
      }),
    );
    await expect(resolveSessionTarget({ raw: "gateway.example/main/a1166b81" })).rejects.toThrow(
      "openclaw devices rotate --device <deviceId> --role operator",
    );
  });

  it("explains how to bootstrap auth when no origin token exists", async () => {
    callGatewayMock.mockRejectedValue(
      new GatewayStoredDeviceAuthUnavailableError("No stored device auth"),
    );

    await expect(resolveSessionTarget({ raw: "gateway.example/main/a1166b81" })).rejects.toThrow(
      "Pass --token or --password once",
    );
  });

  it.each([
    {
      code: "ENOTFOUND",
      target: "gateway.example/main/a1166b81",
      expected: /Could not reach gateway wss:\/\/gateway\.example[\s\S]*tailnet or SSH tunnel/u,
    },
  ])("names unreachable origins for $code", async ({ code, target, expected }) => {
    callGatewayMock.mockRejectedValue(Object.assign(new Error(`connect ${code}`), { code }));

    await expect(resolveSessionTarget({ raw: target })).rejects.toThrow(expected);
  });

  it("uses transport connection details for configured-remote bare refs", async () => {
    callGatewayMock.mockRejectedValue(
      gatewayTransportError({
        kind: "timeout",
        url: "wss://claw.example.ts.net/base",
        message: "gateway timeout after 10000ms",
      }),
    );

    await expect(
      resolveSessionTarget({
        raw: "a1166b81",
        gateway: {
          config: {
            gateway: {
              mode: "remote",
              remote: { url: "wss://claw.example.ts.net/base" },
            },
          },
        },
      }),
    ).rejects.toThrow(
      /Could not reach gateway wss:\/\/claw\.example\.ts\.net\/base[\s\S]*Tailscale/u,
    );
  });

  it("does not mask TLS fingerprint mismatch errors", async () => {
    const mismatch = gatewayTransportError({
      url: "wss://gateway.example",
      message: "gateway tls fingerprint mismatch",
      reason: "gateway tls fingerprint mismatch",
    });
    callGatewayMock.mockRejectedValue(mismatch);

    await expect(resolveSessionTarget({ raw: "gateway.example/main/a1166b81" })).rejects.toBe(
      mismatch,
    );
  });
});
