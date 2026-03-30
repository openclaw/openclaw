import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveControlUiAccessUrl } from "./control-ui-access-url.js";

const mocks = vi.hoisted(() => ({
  resolveConfiguredSecretInputWithFallback: vi.fn(),
  resolveGatewayPort: vi.fn(() => 18789),
  resolveControlUiLinks: vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  })),
}));

vi.mock("../config/config.js", () => ({
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../gateway/resolve-configured-secret-input-string.js", () => ({
  resolveConfiguredSecretInputWithFallback: mocks.resolveConfiguredSecretInputWithFallback,
}));

vi.mock("./onboard-helpers.js", () => ({
  resolveControlUiLinks: mocks.resolveControlUiLinks,
}));

describe("resolveControlUiAccessUrl", () => {
  beforeEach(() => {
    mocks.resolveConfiguredSecretInputWithFallback.mockReset();
    mocks.resolveGatewayPort.mockClear();
    mocks.resolveControlUiLinks.mockClear();
  });

  it("embeds token in URL fragment when token resolves and SecretRef is not used", async () => {
    mocks.resolveConfiguredSecretInputWithFallback.mockResolvedValue({
      value: "tok-secret",
      secretRefConfigured: false,
    });

    const res = await resolveControlUiAccessUrl({
      cfg: { gateway: { auth: { token: "x" } } },
      env: {},
    });

    expect(res.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(res.dashboardUrl).toBe("http://127.0.0.1:18789/#token=tok-secret");
    expect(res.tokenFragmentEmbedded).toBe(true);
    expect(res.tokenSecretRefConfigured).toBe(false);
    expect(res.authToken).toBe("tok-secret");
  });

  it("does not embed token when SecretRef-backed", async () => {
    mocks.resolveConfiguredSecretInputWithFallback.mockResolvedValue({
      value: "from-ref",
      secretRefConfigured: true,
    });

    const res = await resolveControlUiAccessUrl({
      cfg: { gateway: {} },
      env: {},
    });

    expect(res.dashboardUrl).toBe("http://127.0.0.1:18789/");
    expect(res.tokenFragmentEmbedded).toBe(false);
    expect(res.tokenSecretRefConfigured).toBe(true);
    expect(res.authToken).toBe("from-ref");
  });

  it("uses runtime-resolved port override when provided", async () => {
    mocks.resolveConfiguredSecretInputWithFallback.mockResolvedValue({
      secretRefConfigured: false,
    });

    await resolveControlUiAccessUrl({
      cfg: { gateway: {} },
      env: {},
      resolvedPort: 19001,
    });

    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith(
      expect.objectContaining({ port: 19001 }),
    );
    expect(mocks.resolveGatewayPort).not.toHaveBeenCalled();
  });

  it("maps lan bind to loopback for links", async () => {
    mocks.resolveConfiguredSecretInputWithFallback.mockResolvedValue({
      secretRefConfigured: false,
    });

    await resolveControlUiAccessUrl({
      cfg: { gateway: { bind: "lan" } },
      env: {},
    });

    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith(
      expect.objectContaining({ bind: "loopback" }),
    );
  });
});
