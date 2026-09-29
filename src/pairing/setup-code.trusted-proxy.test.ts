import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../shared/device-bootstrap-profile.js";

vi.mock("../infra/device-bootstrap.js", () => ({
  issueDevicePairSetupBootstrapToken: vi.fn(async () => ({
    token: "bootstrap-123",
    expiresAtMs: 123,
    setupId: "setup-123",
  })),
}));

const { resolvePairingSetupFromConfig } = await import("./setup-code.js");
const { issueDevicePairSetupBootstrapToken } = await import("../infra/device-bootstrap.js");
const config = {
  gateway: {
    bind: "custom",
    customBindHost: "127.0.0.1",
    auth: { mode: "trusted-proxy" },
  },
} as const;

describe("trusted-proxy pairing setup", () => {
  beforeEach(() => {
    vi.mocked(issueDevicePairSetupBootstrapToken).mockClear();
  });

  it.each([
    {
      name: "issues full setup codes without a shared secret over TLS",
      url: "wss://gateway.example.test",
      profile: FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      access: "full",
      accessDowngraded: false,
    },
    {
      name: "keeps plaintext LAN handoff limited",
      url: "ws://192.168.1.20:18789",
      profile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
      access: "limited",
      accessDowngraded: true,
    },
  ])("$name", async ({ url, profile, access, accessDowngraded }) => {
    const result = await resolvePairingSetupFromConfig(config, { env: {}, publicUrl: url });
    expect(result).toMatchObject({
      ok: true,
      authLabel: "trusted-proxy",
      payload: { url, bootstrapToken: "bootstrap-123", expiresAtMs: 123 },
      setupId: "setup-123",
      expiresAtMs: 123,
      urlSource: "plugins.entries.device-pair.config.publicUrl",
      access,
      accessDowngraded,
    });
    expect(issueDevicePairSetupBootstrapToken).toHaveBeenCalledExactlyOnceWith({
      baseDir: undefined,
      profile,
    });
    if (result.ok) {
      expect(result.payload).not.toHaveProperty("setupId");
    }
  });

  it("keeps public transport restrictions before issuing credentials", async () => {
    const result = await resolvePairingSetupFromConfig(config, {
      env: {},
      publicUrl: "ws://gateway.example.test",
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "Tailscale and public mobile pairing require a secure gateway URL",
      ),
    });
    expect(issueDevicePairSetupBootstrapToken).not.toHaveBeenCalled();
  });
});
