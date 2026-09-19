import os from "node:os";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { WizardCancelledError } from "../wizard/prompts.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  note: vi.fn(),
  restart: vi.fn(),
  findTailscale: vi.fn(),
  run: vi.fn(),
  httpProbe: vi.fn(),
  probeGateway: vi.fn(),
  probeAuth: vi.fn(),
}));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshotForWrite: mocks.read,
}));
vi.mock("../wizard/setup.shared.js", () => ({ writeWizardConfigFile: mocks.write }));
vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => ({ select: mocks.select, confirm: mocks.confirm, note: mocks.note }),
}));
vi.mock("./daemon-cli/lifecycle.js", () => ({ runDaemonRestart: mocks.restart }));
vi.mock("../infra/tailscale.js", () => ({
  findTailscaleBinary: mocks.findTailscale,
  getTailnetHostname: async () => "gateway.tailnet.ts.net",
}));
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: mocks.run }));
vi.mock("../gateway/local-http-probe.js", () => ({
  createConfiguredGatewayLocalProbe: () => ({ requestHttp: mocks.httpProbe }),
}));
vi.mock("../commands/onboard-helpers.js", () => ({ probeGatewayReachable: mocks.probeGateway }));
vi.mock("../gateway/probe-auth.js", () => ({
  resolveGatewayProbeAuthSafeWithSecretInputs: mocks.probeAuth,
}));
vi.mock("../runtime.js", () => ({ defaultRuntime: { log: vi.fn() } }));

const { setupQrPhoneAccess } = await import("./qr-setup.js");

describe("QR phone setup", () => {
  let config: OpenClawConfig;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "");
    config = {
      gateway: {
        mode: "local",
        bind: "loopback",
        port: 18789,
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MY_GATEWAY_TOKEN" },
        },
        controlUi: { enabled: true, allowedOrigins: ["https://existing.example"] },
      },
    };
    mocks.read.mockImplementation(async () => ({
      snapshot: { valid: true, exists: true, hash: "before", config, sourceConfig: config },
      writeOptions: { expectedConfigPath: "/fixture/openclaw.json" },
    }));
    mocks.write.mockImplementation(async (nextConfig: OpenClawConfig) => ({ nextConfig }));
    mocks.select.mockResolvedValue("lan");
    mocks.confirm.mockResolvedValue(true);
    mocks.restart.mockResolvedValue(true);
    mocks.httpProbe.mockResolvedValue({ statusCode: 200 });
    mocks.probeGateway.mockResolvedValue({ ok: true });
    mocks.probeAuth.mockResolvedValue({ auth: { token: "resolved-test-token" } });
    mocks.findTailscale.mockResolvedValue("/fixture/tailscale");
    mocks.run.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ Self: { DNSName: "gateway.tailnet.ts.net." } }),
    });
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      eth0: [
        {
          address: "192.168.1.8",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
          mac: "00:00:00:00:00:00",
          cidr: "192.168.1.8/24",
        },
      ],
    });
  });

  it("uses setup defaults, preserves secrets and origins, and activates only after consent", async () => {
    mocks.confirm.mockImplementation(async () => {
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
      return true;
    });
    const result = await setupQrPhoneAccess();
    expect(result.gateway).toMatchObject({
      bind: "lan",
      auth: config.gateway?.auth,
      tailscale: { mode: "off" },
    });
    expect(result.gateway?.controlUi?.allowedOrigins).toContain("https://existing.example");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("all network interfaces"),
      "Phone access",
    );
    expect(mocks.write).toHaveBeenCalledWith(
      result,
      expect.objectContaining({
        baseSnapshot: expect.objectContaining({ hash: "before" }),
        mergeBase: config,
        writeOptions: { expectedConfigPath: "/fixture/openclaw.json" },
      }),
    );
    expect(mocks.restart.mock.invocationCallOrder[0]).toBeGreaterThan(
      expectDefined(mocks.write.mock.invocationCallOrder[0], "config write"),
    );
    expect(mocks.httpProbe).toHaveBeenCalledWith(
      expect.objectContaining({ host: "192.168.1.8", port: 18789, pathname: "/readyz" }),
    );
    expect(mocks.probeGateway).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.write.mock.calls)).not.toContain("resolved-test-token");
    expect(config.gateway?.bind).toBe("loopback");
  });

  it.each([80, 443])(
    "probes the configured port even when URL parsing omits default port %s",
    async (port) => {
      config.gateway = { ...config.gateway, port, tls: { enabled: port === 443 } };
      await setupQrPhoneAccess();
      expect(mocks.httpProbe).toHaveBeenCalledWith(expect.objectContaining({ port }));
    },
  );

  it("keeps Tailscale private and verifies the encrypted advertised endpoint", async () => {
    mocks.select.mockResolvedValue("serve");
    const result = await setupQrPhoneAccess();
    expect(result.gateway).toMatchObject({
      bind: "loopback",
      tailscale: { mode: "serve" },
      auth: config.gateway?.auth,
    });
    expect(result.gateway?.controlUi?.allowedOrigins).toContain("https://gateway.tailnet.ts.net");
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("does not publish"),
      "Phone access",
    );
    expect(mocks.probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({ url: "wss://gateway.tailnet.ts.net" }),
    );
    expect(mocks.httpProbe).not.toHaveBeenCalled();
  });

  it.each(["not-now", "decline", "cancel-selection", "cancel-confirmation"])(
    "makes no changes on %s",
    async (step) => {
      if (step === "not-now") {
        mocks.select.mockResolvedValue("cancel");
      }
      if (step === "decline") {
        mocks.confirm.mockResolvedValue(false);
      }
      if (step === "cancel-selection") {
        mocks.select.mockRejectedValue(new WizardCancelledError());
      }
      if (step === "cancel-confirmation") {
        mocks.confirm.mockRejectedValue(new WizardCancelledError());
      }
      await expect(setupQrPhoneAccess()).rejects.toBeInstanceOf(WizardCancelledError);
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
    },
  );

  it.each(["missing-binary", "disconnected"])(
    "does not save unusable Tailscale access (%s)",
    async (failure) => {
      mocks.select.mockResolvedValue("serve");
      if (failure === "missing-binary") {
        mocks.findTailscale.mockResolvedValue(null);
      } else {
        mocks.run.mockResolvedValue({ code: 1, stdout: "" });
      }
      await expect(setupQrPhoneAccess()).rejects.toThrow("Tailscale");
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.confirm).not.toHaveBeenCalled();
    },
  );

  it("leaves settings alone when no LAN address is available", async () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({});
    await expect(setupQrPhoneAccess()).rejects.toThrow("No local network address");
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("honors a concurrent config write rejection without restarting", async () => {
    mocks.write.mockRejectedValue(new Error("config changed"));
    await expect(setupQrPhoneAccess()).rejects.toThrow("config changed");
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it.each([false, "throw"])(
    "reports saved settings instead of a QR on restart failure (%s)",
    async (failure) => {
      if (failure === false) {
        mocks.restart.mockResolvedValue(false);
      } else {
        mocks.restart.mockRejectedValue(new Error("restart failed"));
      }
      await expect(setupQrPhoneAccess()).rejects.toThrow("settings were saved");
      expect(mocks.write).toHaveBeenCalledOnce();
      expect(mocks.httpProbe).not.toHaveBeenCalled();
    },
  );

  it("does not treat a scheduled restart as an activated phone endpoint", async () => {
    mocks.httpProbe.mockResolvedValue(null);
    await expect(setupQrPhoneAccess()).rejects.toThrow("phone address is not ready");
  });

  it.each(["remote", "trusted-proxy", "none", "missing-auth"])(
    "does not expose an incompatible fresh config (%s)",
    async (mode) => {
      if (mode === "remote") {
        config.gateway!.mode = "remote";
      } else if (mode === "trusted-proxy" || mode === "none") {
        config.gateway!.auth!.mode = mode;
      } else {
        mocks.probeAuth.mockResolvedValue({ auth: {} });
      }
      await expect(setupQrPhoneAccess()).rejects.toThrow();
      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    },
  );
});
