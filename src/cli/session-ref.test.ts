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

function errorText(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String(error);
  }
  throw new Error("Expected invocation to throw");
}

const resolveRemote = () => resolveSessionTarget({ raw: "gateway.example/main/a1166b81" });
const expectGatewayCall = (expected: object) =>
  expect(callGatewayMock).toHaveBeenCalledWith(expect.objectContaining(expected));
const requestError = (message: string, code?: string) =>
  new GatewayClientRequestError({
    code: "INVALID_REQUEST",
    message,
    ...(code ? { details: { code } } : {}),
  });
const transportError = (url: string, kind: "timeout" | "closed", message: string) =>
  new GatewayTransportError({
    kind,
    message,
    ...(kind === "closed" ? { reason: message } : {}),
    connectionDetails: { url, urlSource: "cli --url", message: `Gateway target: ${url}` },
  });
function expectRedacted(run: () => unknown, expected: string) {
  const error = errorText(run);
  expect(error).toContain(expected);
  expect(error).not.toContain("do-not-print-me");
}

beforeEach(() => {
  callGatewayMock.mockReset();
  delete process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS;
});

describe("session target parsing", () => {
  it.each([
    [
      "wss://gateway.example/base/chat/ops/telegram/123?view=compact#messages",
      "/base",
      { kind: "literal", sessionKey: "agent:ops:telegram:123" },
    ],
    [
      "Gateway.Example/Ops/movies-A1166B81/",
      "",
      { kind: "short", shortId: "a1166b81", slugHint: "movies" },
    ],
  ])("parses %s", (input, basePath, ref) => {
    expect(parseSessionTargetInput(input)).toEqual({
      kind: "url",
      origin: "wss://gateway.example",
      agentId: "ops",
      basePath,
      ref,
    });
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

  it.each([
    "user:do-not-print-me@gateway.example/dashboard/main/movies-a1166b81",
    "gateway.example/dashboard/main/movies-a1166b81?token=do-not-print-me",
    "gateway.example/dashboard/main/movies-a1166b81#password=do-not-print-me",
  ])("rejects URL credentials without echoing them: %s", (target) => {
    expectRedacted(
      () => parseSessionTargetInput(`https://${target}`),
      "must not contain credentials",
    );
  });

  it("surfaces the canonical plaintext WebSocket security gate", () => {
    expect(() =>
      parseSessionTargetInput("ws://gateway.example/dashboard/main/movies-a1166b81"),
    ).toThrow("SECURITY ERROR: Gateway URL");
  });
});

describe("bare-root session URL options", () => {
  const target = "https://gateway.example/dashboard/main/movies-a1166b81";
  const value = "https://example.com/article";
  const parse = (...args: string[]) => parseBareSessionInvocation(["node", "openclaw", ...args]);

  it.each([
    ["--message", value, target],
    [`--message=${value}`, target],
    [target, "--message", value],
    [target, `--message=${value}`],
  ])("parses --message around the URL, split or inline: %j", (...args) => {
    expect(parse(...args)).toEqual({ target, options: { message: value } });
  });

  it("parses boolean options on either side and preserves root globals", () => {
    expect(
      parse(
        "--no-color",
        "--profile",
        "work",
        "--deliver",
        target,
        "--log-level=debug",
        "--token=direct-token",
      ),
    ).toEqual({ target, options: { deliver: true, token: "direct-token" } });
    expect(parse(target, "--deliver")).toEqual({ target, options: { deliver: true } });
    expect(parse("--screen-reader", target)).toEqual({
      target,
      options: { screenReader: true },
    });
  });

  it.each([["gateway.example/main/a1166b81"], ["unowned-command", target]])(
    "leaves non-bare invocations to their owner: %j",
    (...args) => {
      expect(parse(...args)).toBeNull();
    },
  );

  it.each([
    [["--token", target], "--token requires a value"],
    [[target, "--token"], "--token requires a value"],
    [[target, "--typo=do-not-print-me"], "Unsupported bare session URL option: --typo"],
    [[target, "--"], "Unsupported bare session URL option: --"],
    [[target, "do-not-print-me"], "Unexpected extra argument"],
  ] as const)("rejects %j without reflecting values", (args, expected) => {
    expectRedacted(() => parse(...args), expected);
  });
});

describe("session target resolution", () => {
  it("resolves a stale-agent URL short reference without scoping UUID lookup", async () => {
    callGatewayMock.mockResolvedValue({ ok: true, key: "agent:research:thread:full-key" });

    const result = await resolveSessionTarget({
      raw: "https://gateway.example/base/dashboard/ops/movies-a1166b81",
      gateway: { token: "explicit-token" },
    });

    expect(result.sessionKey).toBe("agent:research:thread:full-key");
    expectGatewayCall({
      url: "wss://gateway.example/base",
      token: "explicit-token",
      method: "sessions.resolve",
      params: { shortId: "a1166b81", slugHint: "movies" },
      useStoredDeviceAuth: true,
      requiredStoredDeviceAuthScopes: ["operator.read"],
    });
  });

  it("uses gateway-advertised routing for URL main sessions without requiring an existing row", async () => {
    callGatewayMock.mockResolvedValue({ mainKey: "workspace", scope: "per-sender" });

    const result = await resolveSessionTarget({
      raw: "https://gateway.example/dashboard/ops",
    });

    expect(result.sessionKey).toBe("agent:ops:workspace");
    expectGatewayCall({
      url: "wss://gateway.example",
      method: "agents.list",
      params: {},
      requiredStoredDeviceAuthScopes: ["operator.read"],
    });
  });

  it.each([
    ["agent:ops:main", "other"],
    ["global", undefined],
  ])("rejects inconsistent resolved ownership %s/%s", async (key, agentId) => {
    callGatewayMock.mockResolvedValue({ ok: true, key, agentId });

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
        ["agent:main:thread:12345678-0aaa-4000-8000-000000000001", "Alpha"],
        ["agent:main:thread:12345678-0bbb-4000-8000-000000000002", "Beta"],
      ].map(([key, displayName]) => ({ key, displayName })),
    });

    await expect(resolveSessionTarget({ raw: "12345678" })).rejects.toThrow(
      /Alpha\s+123456780aaa4000[\s\S]*Beta\s+123456780bbb4000/u,
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("sends remote not-found recovery to the target Control UI, not the local session store", async () => {
    callGatewayMock.mockRejectedValue(requestError("No session found: a1166b81"));

    const error = await resolveRemote().catch(String);
    expect(error).toContain("that gateway's Control UI (https://gateway.example)");
    expect(error).not.toContain("sessions list --url");
  });

  it.each([
    [
      requestError("invalid sessions.resolve params: at root: unexpected property 'shortId'"),
      "This gateway predates short-link resolution; pass the full session key. Choose a full session key from that gateway's Control UI (https://gateway.example).",
    ],
    [requestError("connect failed", "PAIRING_REQUIRED"), "openclaw devices approve --latest"],
    [
      requestError("connect failed", "AUTH_DEVICE_TOKEN_MISMATCH"),
      "openclaw devices rotate --device <deviceId> --role operator",
    ],
    [
      new GatewayStoredDeviceAuthUnavailableError("No stored device auth"),
      "Pass --token or --password once",
    ],
    [
      Object.assign(new Error("connect ENOTFOUND"), { code: "ENOTFOUND" }),
      /Could not reach gateway wss:\/\/gateway\.example[\s\S]*tailnet or SSH tunnel/u,
    ],
  ])("provides recovery guidance for %s", async (error, expected) => {
    callGatewayMock.mockRejectedValue(error);
    await expect(resolveRemote()).rejects.toThrow(expected);
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("uses transport connection details for configured-remote bare refs", async () => {
    const url = "wss://claw.example.ts.net/base";
    callGatewayMock.mockRejectedValue(
      transportError(url, "timeout", "gateway timeout after 10000ms"),
    );

    await expect(
      resolveSessionTarget({
        raw: "a1166b81",
        gateway: { config: { gateway: { mode: "remote", remote: { url } } } },
      }),
    ).rejects.toThrow(
      /Could not reach gateway wss:\/\/claw\.example\.ts\.net\/base[\s\S]*Tailscale/u,
    );
  });

  it("does not mask TLS fingerprint mismatch errors", async () => {
    const url = "wss://gateway.example";
    const mismatch = transportError(url, "closed", "gateway tls fingerprint mismatch");
    callGatewayMock.mockRejectedValue(mismatch);

    await expect(resolveRemote()).rejects.toBe(mismatch);
  });
});
