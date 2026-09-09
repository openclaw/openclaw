import { describe, expect, it } from "vitest";
import { mergeInstallInvocationEnv } from "./install.js";

describe("mergeInstallInvocationEnv", () => {
  it("canonicalizes Windows install env keys while filtering dangerous loader env", () => {
    const env = mergeInstallInvocationEnv({
      env: {
        Path: "C:\\Windows\\System32",
        openai_api_key: "service-openai-key",
        NODE_OPTIONS: "--require C:\\temp\\untrusted.js",
      },
      platform: "win32",
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
        platform,
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
      const env = mergeInstallInvocationEnv({
        env: { [shellKey]: "/opt/openclaw/current-shell-ca.pem" },
        existingServiceEnv: {
          NODE_EXTRA_CA_CERTS: "/opt/openclaw/previous-service-ca.pem",
        },
        platform,
      });

      expect(env.NODE_EXTRA_CA_CERTS).toBe("/opt/openclaw/current-shell-ca.pem");
    },
  );
});
