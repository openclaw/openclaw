import { describe, expect, it, vi } from "vitest";
import { buildServiceEnvironment } from "../../daemon/service-env.js";
import { createSecretEgressProxyEnvironment } from "../../secrets/egress-proxy/environment.js";
import { mergeInstallInvocationEnv } from "./install.js";

describe("mergeInstallInvocationEnv", () => {
  it.each(["forged receipt", "operator override"])("preserves operator CA with %s", (scenario) => {
    const operator = {
      NODE_EXTRA_CA_CERTS: "/state/secret-egress-proxy/operator-ca.pem",
      CUSTOM_SETTING: "keep",
    };
    const proxy =
      scenario === "forged receipt"
        ? { OPENCLAW_SECRET_EGRESS_PROXY_ENV: JSON.stringify(operator) }
        : createSecretEgressProxyEnvironment(
            "http://openclaw:test-token@127.0.0.1:9000",
            "/state/secret-egress-proxy/gateway-test/trust-bundle.pem",
          );
    const env = mergeInstallInvocationEnv({
      env: { ...proxy, ...operator },
    });
    expect(env).toMatchObject(operator);
    expect(
      buildServiceEnvironment({ env, platform: "linux", port: 18789 }).NODE_EXTRA_CA_CERTS,
    ).toBe(operator.NODE_EXTRA_CA_CERTS);
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

  it.each([
    ["linux", false, true],
    ["win32", false, true],
    ["darwin", true, true],
    ["win32", true, true],
    ["win32", false, false],
  ] as const)(
    "filters %s install env (shell CA=%s, installed env=%s)",
    (platform, override, installed) => {
      vi.stubGlobal("process", { ...process, platform });
      const caKey = platform === "win32" ? "node_extra_ca_certs" : "NODE_EXTRA_CA_CERTS";
      const ca = "/opt/openclaw/corporate-ca.pem";
      const currentCa = "/opt/openclaw/current-shell-ca.pem";
      const env = mergeInstallInvocationEnv({
        env: {
          [platform === "win32" ? "Path" : "PATH"]: "/usr/bin",
          NODE_OPTIONS: "--require /tmp/untrusted.js",
          ...(!installed ? { openai_api_key: "shell-key" } : {}),
          ...(override ? { [caKey]: currentCa } : {}),
        },
        existingServiceEnv: installed
          ? {
              [caKey]: ` ${ca} `,
              NODE_TLS_REJECT_UNAUTHORIZED: "0",
              HTTPS_PROXY: "https://attacker.invalid",
              NODE_OPTIONS: "--require /tmp/untrusted.js",
              BASH_ENV: "/tmp/untrusted.sh",
              LD_PRELOAD: "/tmp/untrusted.so",
              OPENAI_API_KEY: "existing-service-key",
            }
          : undefined,
      });
      expect(env).toEqual({
        ...(installed ? { NODE_EXTRA_CA_CERTS: override ? currentCa : ca } : {}),
        OPENAI_API_KEY: installed ? "existing-service-key" : "shell-key",
        PATH: "/usr/bin",
      });
    },
  );
});
