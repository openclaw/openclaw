import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createGatewayCredentialPlan,
  hasGatewayPasswordEnvCandidate,
  hasGatewayTokenEnvCandidate,
  readGatewayPasswordEnv,
  readGatewayTokenEnv,
  trimCredentialToUndefined,
  trimToUndefined,
} from "./credential-planner.js";

// ---------------------------------------------------------------------------
// trimToUndefined
// ---------------------------------------------------------------------------
describe("trimToUndefined", () => {
  it("returns undefined for non-string values", () => {
    expect(trimToUndefined(undefined)).toBeUndefined();
    expect(trimToUndefined(null)).toBeUndefined();
    expect(trimToUndefined(42)).toBeUndefined();
    expect(trimToUndefined(true)).toBeUndefined();
    expect(trimToUndefined({})).toBeUndefined();
  });

  it("returns undefined for empty strings", () => {
    expect(trimToUndefined("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only strings", () => {
    expect(trimToUndefined("   ")).toBeUndefined();
    expect(trimToUndefined("\t\n")).toBeUndefined();
  });

  it("trims and returns normal strings", () => {
    expect(trimToUndefined("hello")).toBe("hello");
    expect(trimToUndefined("  hello  ")).toBe("hello");
  });

  it("preserves inner whitespace", () => {
    expect(trimToUndefined("  hello world  ")).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// trimCredentialToUndefined
// ---------------------------------------------------------------------------
describe("trimCredentialToUndefined", () => {
  it("returns undefined for non-string values", () => {
    expect(trimCredentialToUndefined(undefined)).toBeUndefined();
    expect(trimCredentialToUndefined(null)).toBeUndefined();
  });

  it("returns undefined for empty / whitespace-only strings", () => {
    expect(trimCredentialToUndefined("")).toBeUndefined();
    expect(trimCredentialToUndefined("   ")).toBeUndefined();
  });

  it("rejects unresolved env var placeholder strings", () => {
    expect(trimCredentialToUndefined("${OPENCLAW_GATEWAY_TOKEN}")).toBeUndefined();
    expect(trimCredentialToUndefined("${MY_SECRET}")).toBeUndefined();
    expect(trimCredentialToUndefined("prefix-${TOKEN}-suffix")).toBeUndefined();
  });

  it("returns normal credential strings", () => {
    expect(trimCredentialToUndefined("my-secret-token")).toBe("my-secret-token");
    expect(trimCredentialToUndefined("  my-secret-token  ")).toBe("my-secret-token");
  });

  it("allows strings that do not match env var syntax", () => {
    // Lowercase does not match uppercase env var patterns
    expect(trimCredentialToUndefined("${lowercase}")).toBe("${lowercase}");
    expect(trimCredentialToUndefined("just-a-dollar-$ign")).toBe("just-a-dollar-$ign");
  });
});

// ---------------------------------------------------------------------------
// readGatewayTokenEnv / readGatewayPasswordEnv
// ---------------------------------------------------------------------------
describe("readGatewayTokenEnv", () => {
  it("reads OPENCLAW_GATEWAY_TOKEN from env", () => {
    const env = { OPENCLAW_GATEWAY_TOKEN: "tok123" } as NodeJS.ProcessEnv;
    expect(readGatewayTokenEnv(env)).toBe("tok123");
  });

  it("returns undefined when env var is missing", () => {
    expect(readGatewayTokenEnv({})).toBeUndefined();
  });

  it("returns undefined when env var is empty/whitespace", () => {
    expect(readGatewayTokenEnv({ OPENCLAW_GATEWAY_TOKEN: "  " })).toBeUndefined();
  });
});

describe("readGatewayPasswordEnv", () => {
  it("reads OPENCLAW_GATEWAY_PASSWORD from env", () => {
    const env = { OPENCLAW_GATEWAY_PASSWORD: "pass456" } as NodeJS.ProcessEnv;
    expect(readGatewayPasswordEnv(env)).toBe("pass456");
  });

  it("returns undefined when env var is missing", () => {
    expect(readGatewayPasswordEnv({})).toBeUndefined();
  });

  it("returns undefined when env var is empty/whitespace", () => {
    expect(readGatewayPasswordEnv({ OPENCLAW_GATEWAY_PASSWORD: "" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// hasGateway{Token,Password}EnvCandidate
// ---------------------------------------------------------------------------
describe("hasGatewayTokenEnvCandidate", () => {
  it("returns true when token env var is set", () => {
    expect(hasGatewayTokenEnvCandidate({ OPENCLAW_GATEWAY_TOKEN: "tok" })).toBe(true);
  });

  it("returns false when token env var is missing or empty", () => {
    expect(hasGatewayTokenEnvCandidate({})).toBe(false);
    expect(hasGatewayTokenEnvCandidate({ OPENCLAW_GATEWAY_TOKEN: "" })).toBe(false);
  });
});

describe("hasGatewayPasswordEnvCandidate", () => {
  it("returns true when password env var is set", () => {
    expect(hasGatewayPasswordEnvCandidate({ OPENCLAW_GATEWAY_PASSWORD: "pw" })).toBe(true);
  });

  it("returns false when password env var is missing or empty", () => {
    expect(hasGatewayPasswordEnvCandidate({})).toBe(false);
    expect(hasGatewayPasswordEnvCandidate({ OPENCLAW_GATEWAY_PASSWORD: "" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createGatewayCredentialPlan
// ---------------------------------------------------------------------------
describe("createGatewayCredentialPlan", () => {
  const emptyEnv = {} as NodeJS.ProcessEnv;

  function plan(config: OpenClawConfig, env: NodeJS.ProcessEnv = emptyEnv) {
    return createGatewayCredentialPlan({ config, env });
  }

  // -- auth mode propagation -----------------------------------------------
  describe("authMode propagation", () => {
    it("returns undefined authMode when gateway config is absent", () => {
      expect(plan({}).authMode).toBeUndefined();
    });

    it.each(["token", "password", "none", "trusted-proxy"] as const)(
      "propagates authMode=%s",
      (mode) => {
        const result = plan({ gateway: { auth: { mode } } });
        expect(result.authMode).toBe(mode);
      },
    );
  });

  // -- configuredMode ------------------------------------------------------
  describe("configuredMode", () => {
    it('defaults to "local"', () => {
      expect(plan({}).configuredMode).toBe("local");
    });

    it('returns "remote" when gateway.mode is remote', () => {
      expect(plan({ gateway: { mode: "remote" } }).configuredMode).toBe("remote");
    });

    it('returns "local" when gateway.mode is local', () => {
      expect(plan({ gateway: { mode: "local" } }).configuredMode).toBe("local");
    });
  });

  // -- env token / password reading ----------------------------------------
  describe("env credential reading", () => {
    it("picks up OPENCLAW_GATEWAY_TOKEN from env", () => {
      const result = plan({}, { OPENCLAW_GATEWAY_TOKEN: "envtok" } as NodeJS.ProcessEnv);
      expect(result.envToken).toBe("envtok");
    });

    it("picks up OPENCLAW_GATEWAY_PASSWORD from env", () => {
      const result = plan({}, { OPENCLAW_GATEWAY_PASSWORD: "envpw" } as NodeJS.ProcessEnv);
      expect(result.envPassword).toBe("envpw");
    });

    it("env values are undefined when not set", () => {
      const result = plan({});
      expect(result.envToken).toBeUndefined();
      expect(result.envPassword).toBeUndefined();
    });
  });

  // -- localTokenCanWin / tokenCanWin / passwordCanWin ---------------------
  describe("token vs password win flags", () => {
    it("localTokenCanWin is true when authMode is undefined", () => {
      expect(plan({}).localTokenCanWin).toBe(true);
    });

    it("localTokenCanWin is true when authMode is token", () => {
      expect(plan({ gateway: { auth: { mode: "token" } } }).localTokenCanWin).toBe(true);
    });

    it("localTokenCanWin is false for password/none/trusted-proxy", () => {
      expect(plan({ gateway: { auth: { mode: "password" } } }).localTokenCanWin).toBe(false);
      expect(plan({ gateway: { auth: { mode: "none" } } }).localTokenCanWin).toBe(false);
      expect(plan({ gateway: { auth: { mode: "trusted-proxy" } } }).localTokenCanWin).toBe(false);
    });

    it("tokenCanWin is true when envToken is present", () => {
      const result = plan({}, { OPENCLAW_GATEWAY_TOKEN: "tok" } as NodeJS.ProcessEnv);
      expect(result.tokenCanWin).toBe(true);
    });

    it("tokenCanWin is false with no token sources", () => {
      expect(plan({}).tokenCanWin).toBe(false);
    });

    it("passwordCanWin is true when authMode is password", () => {
      expect(plan({ gateway: { auth: { mode: "password" } } }).passwordCanWin).toBe(true);
    });

    it("passwordCanWin is false when authMode is token", () => {
      const result = plan({ gateway: { auth: { mode: "token" } } });
      expect(result.passwordCanWin).toBe(false);
    });

    it("passwordCanWin is false when authMode is none", () => {
      expect(plan({ gateway: { auth: { mode: "none" } } }).passwordCanWin).toBe(false);
    });

    it("passwordCanWin is false when authMode is trusted-proxy", () => {
      expect(plan({ gateway: { auth: { mode: "trusted-proxy" } } }).passwordCanWin).toBe(false);
    });

    it("passwordCanWin falls back to true when no token candidate exists and mode is unset", () => {
      // No tokens configured, no env token, mode unset => password can win
      const result = plan({});
      expect(result.passwordCanWin).toBe(true);
    });

    it("passwordCanWin is false when token can win with unset mode", () => {
      // env token present, mode unset => token wins, password cannot
      const result = plan({}, { OPENCLAW_GATEWAY_TOKEN: "tok" } as NodeJS.ProcessEnv);
      expect(result.passwordCanWin).toBe(false);
    });
  });

  // -- env-wins-over-config precedence -------------------------------------
  describe("env-wins-over-config precedence", () => {
    it("envToken suppresses localTokenSurfaceActive", () => {
      const result = plan(
        { gateway: { auth: { mode: "token", token: "config-tok" } } },
        { OPENCLAW_GATEWAY_TOKEN: "env-tok" } as NodeJS.ProcessEnv,
      );
      expect(result.envToken).toBe("env-tok");
      expect(result.localTokenSurfaceActive).toBe(false);
    });

    it("envToken suppresses remoteTokenFallbackActive", () => {
      const result = plan(
        { gateway: { mode: "remote", remote: { url: "wss://gw.example.com" } } },
        { OPENCLAW_GATEWAY_TOKEN: "env-tok" } as NodeJS.ProcessEnv,
      );
      expect(result.remoteTokenFallbackActive).toBe(false);
    });

    it("envPassword suppresses remotePasswordFallbackActive", () => {
      const result = plan(
        { gateway: { auth: { mode: "password" } } },
        { OPENCLAW_GATEWAY_PASSWORD: "env-pw" } as NodeJS.ProcessEnv,
      );
      expect(result.remotePasswordFallbackActive).toBe(false);
    });
  });

  // -- localTokenSurfaceActive ---------------------------------------------
  describe("localTokenSurfaceActive", () => {
    it("active when authMode=token and no env token", () => {
      const result = plan({ gateway: { auth: { mode: "token" } } });
      expect(result.localTokenSurfaceActive).toBe(true);
    });

    it("active when authMode is undefined and no password configured", () => {
      const result = plan({});
      expect(result.localTokenSurfaceActive).toBe(true);
    });

    it("inactive when envToken is set", () => {
      const result = plan(
        { gateway: { auth: { mode: "token" } } },
        { OPENCLAW_GATEWAY_TOKEN: "tok" } as NodeJS.ProcessEnv,
      );
      expect(result.localTokenSurfaceActive).toBe(false);
    });

    it("inactive when authMode=password", () => {
      expect(plan({ gateway: { auth: { mode: "password" } } }).localTokenSurfaceActive).toBe(
        false,
      );
    });

    it("inactive when authMode is undefined but password is configured", () => {
      const result = plan({ gateway: { auth: { password: "pw" } } });
      expect(result.localTokenSurfaceActive).toBe(false);
    });
  });

  // -- remote / tailscale exposure -----------------------------------------
  describe("remote and tailscale exposure paths", () => {
    it("remoteMode is true when gateway.mode=remote", () => {
      expect(plan({ gateway: { mode: "remote" } }).remoteMode).toBe(true);
    });

    it("remoteMode is false by default", () => {
      expect(plan({}).remoteMode).toBe(false);
    });

    it("remoteUrlConfigured is true when remote.url is set", () => {
      const result = plan({ gateway: { remote: { url: "wss://gw.example.com" } } });
      expect(result.remoteUrlConfigured).toBe(true);
    });

    it("remoteUrlConfigured is false when remote.url is whitespace", () => {
      const result = plan({ gateway: { remote: { url: "   " } } });
      expect(result.remoteUrlConfigured).toBe(false);
    });

    it("tailscaleRemoteExposure is true for serve mode", () => {
      expect(plan({ gateway: { tailscale: { mode: "serve" } } }).tailscaleRemoteExposure).toBe(
        true,
      );
    });

    it("tailscaleRemoteExposure is true for funnel mode", () => {
      expect(plan({ gateway: { tailscale: { mode: "funnel" } } }).tailscaleRemoteExposure).toBe(
        true,
      );
    });

    it("tailscaleRemoteExposure is false for off mode", () => {
      expect(plan({ gateway: { tailscale: { mode: "off" } } }).tailscaleRemoteExposure).toBe(
        false,
      );
    });

    it("remoteConfiguredSurface is true when any remote path is active", () => {
      expect(plan({ gateway: { mode: "remote" } }).remoteConfiguredSurface).toBe(true);
      expect(
        plan({ gateway: { remote: { url: "wss://gw.example.com" } } }).remoteConfiguredSurface,
      ).toBe(true);
      expect(plan({ gateway: { tailscale: { mode: "funnel" } } }).remoteConfiguredSurface).toBe(
        true,
      );
    });

    it("remoteConfiguredSurface is false when no remote path is configured", () => {
      expect(plan({}).remoteConfiguredSurface).toBe(false);
    });
  });

  // -- remote credential fallbacks -----------------------------------------
  describe("remote credential fallback flags", () => {
    it("remoteTokenFallbackActive is true when localTokenCanWin and no env/local token", () => {
      // Default config: localTokenCanWin=true, no env token, no local token configured
      const result = plan({});
      expect(result.remoteTokenFallbackActive).toBe(true);
    });

    it("remoteTokenFallbackActive is false when envToken is set", () => {
      const result = plan({}, { OPENCLAW_GATEWAY_TOKEN: "tok" } as NodeJS.ProcessEnv);
      expect(result.remoteTokenFallbackActive).toBe(false);
    });

    it("remoteTokenFallbackActive is false when local token is configured", () => {
      const result = plan({ gateway: { auth: { token: "local-tok" } } });
      expect(result.remoteTokenFallbackActive).toBe(false);
    });

    it("remotePasswordFallbackActive is true when passwordCanWin and no env/local password", () => {
      // No token candidates, mode unset => passwordCanWin=true, no env or local pw
      const result = plan({});
      expect(result.remotePasswordFallbackActive).toBe(true);
    });

    it("remotePasswordFallbackActive is false when envPassword is set", () => {
      const result = plan(
        { gateway: { auth: { mode: "password" } } },
        { OPENCLAW_GATEWAY_PASSWORD: "pw" } as NodeJS.ProcessEnv,
      );
      expect(result.remotePasswordFallbackActive).toBe(false);
    });

    it("remoteTokenActive is true when remoteConfiguredSurface is true", () => {
      const result = plan({ gateway: { mode: "remote" } });
      expect(result.remoteTokenActive).toBe(true);
    });

    it("remoteTokenActive is true when remoteTokenFallbackActive is true", () => {
      const result = plan({});
      expect(result.remoteTokenActive).toBe(true);
    });

    it("remotePasswordActive is true when remoteConfiguredSurface is true", () => {
      const result = plan({ gateway: { mode: "remote" } });
      expect(result.remotePasswordActive).toBe(true);
    });
  });

  // -- local credential configured inputs ----------------------------------
  describe("local/remote credential configured inputs", () => {
    it("reports local token as configured when value is set", () => {
      const result = plan({ gateway: { auth: { token: "my-tok" } } });
      expect(result.localToken.configured).toBe(true);
      expect(result.localToken.value).toBe("my-tok");
      expect(result.localToken.path).toBe("gateway.auth.token");
      expect(result.localToken.hasSecretRef).toBe(false);
    });

    it("reports local token as not configured when absent", () => {
      const result = plan({});
      expect(result.localToken.configured).toBe(false);
      expect(result.localToken.value).toBeUndefined();
    });

    it("reports local password as configured when value is set", () => {
      const result = plan({ gateway: { auth: { password: "my-pw" } } });
      expect(result.localPassword.configured).toBe(true);
      expect(result.localPassword.value).toBe("my-pw");
      expect(result.localPassword.path).toBe("gateway.auth.password");
    });

    it("reports remote token with correct path", () => {
      const result = plan({ gateway: { remote: { token: "rem-tok" } } });
      expect(result.remoteToken.configured).toBe(true);
      expect(result.remoteToken.value).toBe("rem-tok");
      expect(result.remoteToken.path).toBe("gateway.remote.token");
    });

    it("reports remote password with correct path", () => {
      const result = plan({ gateway: { remote: { password: "rem-pw" } } });
      expect(result.remotePassword.configured).toBe(true);
      expect(result.remotePassword.value).toBe("rem-pw");
      expect(result.remotePassword.path).toBe("gateway.remote.password");
    });
  });
});
