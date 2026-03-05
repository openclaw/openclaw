import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn());
const resolveSecretInputRefMock = vi.hoisted(() =>
  vi.fn((): { ref: unknown } => ({ ref: undefined })),
);
const resolveGatewayAuthMock = vi.hoisted(() =>
  vi.fn(() => ({
    mode: "token",
    token: undefined,
    password: undefined,
    allowTailscale: false,
  })),
);
const resolveSecretRefValuesMock = vi.hoisted(() => vi.fn());
const secretRefKeyMock = vi.hoisted(() => vi.fn(() => "env:default:OPENCLAW_GATEWAY_TOKEN"));
const randomTokenMock = vi.hoisted(() => vi.fn(() => "generated-token"));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("../config/types.secrets.js", () => ({
  resolveSecretInputRef: resolveSecretInputRefMock,
}));

vi.mock("../gateway/auth.js", () => ({
  resolveGatewayAuth: resolveGatewayAuthMock,
}));

vi.mock("../secrets/ref-contract.js", () => ({
  secretRefKey: secretRefKeyMock,
}));

vi.mock("../secrets/resolve.js", () => ({
  resolveSecretRefValues: resolveSecretRefValuesMock,
}));

vi.mock("./onboard-helpers.js", () => ({
  randomToken: randomTokenMock,
}));

const { resolveGatewayInstallToken } = await import("./gateway-install-token.js");

describe("resolveGatewayInstallToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readConfigFileSnapshotMock.mockResolvedValue({ exists: false, valid: true, config: {} });
    resolveSecretInputRefMock.mockReturnValue({ ref: undefined });
    resolveSecretRefValuesMock.mockResolvedValue(new Map());
    resolveGatewayAuthMock.mockReturnValue({
      mode: "token",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    });
    randomTokenMock.mockReturnValue("generated-token");
  });

  it("uses plaintext gateway.auth.token when configured", async () => {
    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { token: "config-token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      token: "config-token",
      tokenRefConfigured: false,
      unavailableReason: undefined,
      warnings: [],
    });
  });

  it("validates SecretRef token but does not persist resolved plaintext", async () => {
    const tokenRef = { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" };
    resolveSecretInputRefMock.mockReturnValue({ ref: tokenRef });
    resolveSecretRefValuesMock.mockResolvedValue(
      new Map([["env:default:OPENCLAW_GATEWAY_TOKEN", "resolved-token"]]),
    );

    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token", token: tokenRef } },
      } as OpenClawConfig,
      env: { OPENCLAW_GATEWAY_TOKEN: "resolved-token" } as NodeJS.ProcessEnv,
    });

    expect(result.token).toBeUndefined();
    expect(result.tokenRefConfigured).toBe(true);
    expect(result.unavailableReason).toBeUndefined();
    expect(result.warnings.some((message) => message.includes("SecretRef-managed"))).toBeTruthy();
  });

  it("returns unavailable reason when token SecretRef is unresolved in token mode", async () => {
    resolveSecretInputRefMock.mockReturnValue({
      ref: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
    });
    resolveSecretRefValuesMock.mockRejectedValue(new Error("missing env var"));

    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token", token: "${MISSING_GATEWAY_TOKEN}" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.token).toBeUndefined();
    expect(result.unavailableReason).toContain("gateway.auth.token SecretRef is configured");
  });

  it("auto-generates token when no source exists and auto-generation is enabled", async () => {
    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      autoGenerateWhenMissing: true,
    });

    expect(result.token).toBe("generated-token");
    expect(result.unavailableReason).toBeUndefined();
    expect(result.warnings.some((message) => message.includes("Auto-generated"))).toBeTruthy();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("persists auto-generated token when requested", async () => {
    await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      autoGenerateWhenMissing: true,
      persistGeneratedToken: true,
    });

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: {
          auth: {
            mode: "token",
            token: "generated-token",
          },
        },
      }),
    );
  });

  it("drops generated plaintext when config changes to SecretRef before persist", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        gateway: {
          auth: {
            token: "${OPENCLAW_GATEWAY_TOKEN}",
          },
        },
      },
      issues: [],
    });
    resolveSecretInputRefMock.mockReturnValueOnce({ ref: undefined }).mockReturnValueOnce({
      ref: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
    });

    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      autoGenerateWhenMissing: true,
      persistGeneratedToken: true,
    });

    expect(result.token).toBeUndefined();
    expect(
      result.warnings.some((message) => message.includes("skipping plaintext token persistence")),
    ).toBeTruthy();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });
});
