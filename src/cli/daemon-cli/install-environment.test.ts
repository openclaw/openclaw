import { describe, expect, it, vi } from "vitest";
import { buildServiceEnvironment } from "../../daemon/service-env.js";
import { createSecretEgressProxyEnvironment } from "../../secrets/egress-proxy/environment.js";
import { mergeInstallInvocationEnv } from "./install.js";

describe("mergeInstallInvocationEnv", () => {
  it("ignores a forged proxy receipt when capturing operator settings", () => {
    const operator = { NODE_EXTRA_CA_CERTS: "/opt/corporate.pem", CUSTOM_SETTING: "keep" };
    const env = mergeInstallInvocationEnv({
      env: { ...operator, OPENCLAW_SECRET_EGRESS_PROXY_ENV: JSON.stringify(operator) },
    });
    expect(env).toMatchObject(operator);
    expect(
      buildServiceEnvironment({ env, platform: "linux", port: 18789 }).NODE_EXTRA_CA_CERTS,
    ).toBe(operator.NODE_EXTRA_CA_CERTS);
  });

  it("retains operator overrides through intermediate install projections", () => {
    const ca = "/state/secret-egress-proxy/operator-ca.pem";
    const env = mergeInstallInvocationEnv({
      env: {
        ...createSecretEgressProxyEnvironment(
          "http://openclaw:test-token@127.0.0.1:9000",
          "/state/secret-egress-proxy/gateway-test/trust-bundle.pem",
        ),
        NODE_EXTRA_CA_CERTS: ca,
      },
    });
    expect(
      buildServiceEnvironment({ env, platform: "linux", port: 18789 }).NODE_EXTRA_CA_CERTS,
    ).toBe(ca);
  });

  it("drops an expired Gateway proxy CA while preserving the installed corporate CA", () => {
    const env = mergeInstallInvocationEnv({
      env: { NODE_EXTRA_CA_CERTS: "/state/a/secret-egress-proxy/gateway-expired/trust-bundle.pem" },
      existingServiceEnv: { NODE_EXTRA_CA_CERTS: "/opt/corporate-ca.pem" },
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/opt/corporate-ca.pem");
  });

  it("uses only the current shell's HOMEBREW_PREFIX", () => {
    const existingServiceEnv = { HOMEBREW_PREFIX: "/opt/homebrew" };
    const env = mergeInstallInvocationEnv({ env: {}, existingServiceEnv });
    expect(env.HOMEBREW_PREFIX).toBeUndefined();
    const current = mergeInstallInvocationEnv({
      env: { HOMEBREW_PREFIX: "/usr/local" },
      existingServiceEnv,
    });
    expect(current.HOMEBREW_PREFIX).toBe("/usr/local");
  });

  it("canonicalizes Windows install env keys while filtering dangerous loader env", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const env = mergeInstallInvocationEnv({
      env: {
        Path: "C:\\Windows\\System32",
        openai_api_key: "service-openai-key",
        NODE_OPTIONS: "--require C:\\temp\\untrusted.js",
      },
    });

    expect(env).toMatchObject({
      PATH: "C:\\Windows\\System32",
      OPENAI_API_KEY: "service-openai-key",
    });
    expect(env.Path).toBeUndefined();
    expect(env.openai_api_key).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it.each([
    { platform: "darwin" as const, caKey: "NODE_EXTRA_CA_CERTS" },
    { platform: "linux" as const, caKey: "NODE_EXTRA_CA_CERTS" },
    { platform: "win32" as const, caKey: "node_extra_ca_certs" },
  ])(
    "preserves installed additive Node CA trust without unsafe overrides on $platform",
    ({ platform, caKey }) => {
      vi.stubGlobal("process", { ...process, platform });
      const env = mergeInstallInvocationEnv({
        env: { PATH: "/usr/bin" },
        existingServiceEnv: {
          [caKey]: " /opt/openclaw/corporate-ca.pem ",
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          HTTPS_PROXY: "https://attacker.invalid",
          NODE_OPTIONS: "--require /tmp/untrusted.js",
          BASH_ENV: "/tmp/untrusted.sh",
          LD_PRELOAD: "/tmp/untrusted.so",
          OPENAI_API_KEY: "existing-service-key",
        },
      });

      expect(env).toMatchObject({
        NODE_EXTRA_CA_CERTS: "/opt/openclaw/corporate-ca.pem",
        OPENAI_API_KEY: "existing-service-key",
        PATH: "/usr/bin",
      });
      expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
      expect(env.HTTPS_PROXY).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.BASH_ENV).toBeUndefined();
      expect(env.LD_PRELOAD).toBeUndefined();
      if (platform === "win32") {
        expect(env.node_extra_ca_certs).toBeUndefined();
      }
    },
  );

  it.each([
    { platform: "darwin" as const, shellKey: "NODE_EXTRA_CA_CERTS" },
    { platform: "win32" as const, shellKey: "node_extra_ca_certs" },
  ])(
    "lets the current shell override installed Node CA trust on $platform",
    ({ platform, shellKey }) => {
      vi.stubGlobal("process", { ...process, platform });
      const env = mergeInstallInvocationEnv({
        env: { [shellKey]: "/opt/openclaw/current-shell-ca.pem" },
        existingServiceEnv: {
          NODE_EXTRA_CA_CERTS: "/opt/openclaw/previous-service-ca.pem",
        },
      });

      expect(env.NODE_EXTRA_CA_CERTS).toBe("/opt/openclaw/current-shell-ca.pem");
    },
  );
});
