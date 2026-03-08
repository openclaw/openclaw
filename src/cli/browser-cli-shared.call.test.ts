import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayFromCli = vi.fn(async () => ({ ok: true }));

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli,
  };
});

const { callBrowserRequest } = await import("./browser-cli-shared.js");

describe("callBrowserRequest", () => {
  beforeEach(() => {
    callGatewayFromCli.mockClear();
    callGatewayFromCli.mockResolvedValue({ ok: true });
  });

  it("propagates the implicit CLI default timeout when no browser fallback is provided", async () => {
    await callBrowserRequest(
      {
        timeout: "30000",
        timeoutSource: "default",
      },
      {
        method: "POST",
        path: "/start",
      },
    );

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ timeout: "30000" }),
      expect.objectContaining({ timeoutMs: 30000, path: "/start" }),
      expect.objectContaining({ progress: undefined }),
    );
  });

  it("keeps command-specific timeout overrides ahead of the implicit CLI default", async () => {
    await callBrowserRequest(
      {
        timeout: "30000",
        timeoutSource: "default",
      },
      {
        method: "GET",
        path: "/",
      },
      {
        timeoutMs: 1500,
      },
    );

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ timeout: "1500" }),
      expect.objectContaining({ timeoutMs: 1500, path: "/" }),
      expect.objectContaining({ progress: undefined }),
    );
  });
});
