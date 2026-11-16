import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../gateway/client.js";
import { ExpectedCliError } from "./expected-cli-error.js";
import { formatCliFailureLines, isExpectedCliError } from "./failure-output.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return { ...actual, callGateway: callGatewayMock };
});

const { resolveSessionTarget } = await import("./session-target.js");

describe("session target connection errors", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("shapes identity-proxy and malformed-URL connection errors", async () => {
    callGatewayMock.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "gateway rejected websocket upgrade (HTTP 302)",
        details: { reason: "websocket-upgrade-rejected", httpStatus: 302 },
      }),
    );
    const error = await resolveSessionTarget({ raw: "gw.example/main/a1166b81" }).catch(String);
    expect(error).toContain("gateway.remote.edgeAuth");
    expect(error).not.toContain("tailnet");
    expect(error).not.toContain("SSH tunnel");

    callGatewayMock.mockRejectedValueOnce(new Error("SECURITY ERROR: plaintext ws://"));
    await expect(
      resolveSessionTarget({ raw: "agent:ops:main", gateway: { url: "ws://[bad" } }),
    ).rejects.toThrow("SECURITY ERROR: plaintext ws://");
  });
});

// Regression (#200142): operator remedies composed by resolveSessionTarget must reach the
// terminal renderer. attach/tui call it outside runCommandWithRuntime, so only the
// expected-error classification keeps the generic failure collapse from hiding them.
describe("session target operator remedies reach the terminal renderer", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  function terminalLines(error: unknown): string[] {
    return formatCliFailureLines({
      title: "The CLI command failed.",
      error,
      argv: ["node", "openclaw", "attach"],
      env: {},
    });
  }

  it("classifies the conflicting session URL and --url remedy as an expected CLI error", async () => {
    const error = await resolveSessionTarget({
      raw: "https://gateway.example/dashboard/main/movies-a1166b81",
      gateway: { url: "wss://other.example" },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExpectedCliError);
    expect(terminalLines(error)).toEqual([
      "pass one target: use either the session URL or --url, not both",
    ]);
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("classifies the ambiguous-reference candidate table as an expected CLI error", async () => {
    callGatewayMock.mockResolvedValueOnce({
      ok: false,
      candidates: [
        { key: "agent:main:thread:12345678-0aaa-4000-8000-000000000001", displayName: "Alpha" },
        { key: "agent:main:thread:12345678-0bbb-4000-8000-000000000002", displayName: "Beta" },
      ],
    });

    const error = await resolveSessionTarget({ raw: "12345678" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ExpectedCliError);
    const lines = terminalLines(error);
    expect(lines[0]).toBe("Session reference is ambiguous:");
    expect(lines.join("\n")).toMatch(/Alpha\s+123456780aaa4000[\s\S]*Beta\s+123456780bbb4000/u);
    expect(lines.at(-1)).toContain("Pass a longer reference.");
  });

  it("classifies the no-session remedy as an expected CLI error", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: false });

    const error = await resolveSessionTarget({ raw: "a1166b81" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ExpectedCliError);
    const lines = terminalLines(error);
    expect(lines[0]).toBe("No session found.");
    expect(lines.join("\n")).toContain("sessions list");
  });

  it("keeps the inconsistent-agent identity invariant a generic failure", async () => {
    callGatewayMock.mockResolvedValue({
      ok: true,
      key: "agent:main:thread:12345678-0aaa-4000-8000-000000000001",
      agentId: "ops",
    });

    const error = await resolveSessionTarget({ raw: "12345678" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ExpectedCliError);
    expect(isExpectedCliError(error)).toBe(false);
    expect(String(error)).toContain(
      "Gateway returned a session without a consistent agent identity.",
    );
  });
});
