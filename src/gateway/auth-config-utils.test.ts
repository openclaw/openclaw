import { describe, it, expect, vi } from "vitest";
import {
  withGatewayAuthPassword,
  resolveGatewayPasswordSecretRef,
} from "./auth-config-utils.js";
import type { OpenClawConfig } from "../config/config.js";

describe("withGatewayAuthPassword", () => {
  it("should set gateway auth password", () => {
    const cfg: OpenClawConfig = {};
    const result = withGatewayAuthPassword(cfg, "new-password");
    expect(result.gateway?.auth?.password).toBe("new-password");
  });

  it("should preserve existing config", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        port: 8080,
        auth: {
          mode: "password",
        },
      },
    };
    const result = withGatewayAuthPassword(cfg, "new-password");
    expect(result.gateway?.port).toBe(8080);
    expect(result.gateway?.auth?.mode).toBe("password");
    expect(result.gateway?.auth?.password).toBe("new-password");
  });

  it("should create gateway object if not exists", () => {
    const cfg: OpenClawConfig = {};
    const result = withGatewayAuthPassword(cfg, "password");
    expect(result.gateway).toBeDefined();
    expect(result.gateway?.auth).toBeDefined();
  });

  it("should override existing password", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          password: "old-password",
        },
      },
    };
    const result = withGatewayAuthPassword(cfg, "new-password");
    expect(result.gateway?.auth?.password).toBe("new-password");
  });
});

describe("resolveGatewayPasswordSecretRef", () => {
  it("should return unchanged config when no secret ref", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          password: "plain-password",
        },
      },
    };
    const result = await resolveGatewayPasswordSecretRef({
      cfg,
      env: {},
      hasPasswordCandidate: false,
      hasTokenCandidate: false,
    });
    expect(result).toBe(cfg);
  });

  it("should return unchanged config when has password candidate", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          password: "${SECRET:my-password}",
        },
      },
    };
    const result = await resolveGatewayPasswordSecretRef({
      cfg,
      env: {},
      hasPasswordCandidate: true,
      hasTokenCandidate: false,
    });
    expect(result).toBe(cfg);
  });

  it("should return unchanged config in token mode", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          password: "${SECRET:my-password}",
        },
      },
    };
    const result = await resolveGatewayPasswordSecretRef({
      cfg,
      env: {},
      mode: "token",
      hasPasswordCandidate: false,
      hasTokenCandidate: false,
    });
    expect(result).toBe(cfg);
  });

  it("should return unchanged config in none mode", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          password: "${SECRET:my-password}",
        },
      },
    };
    const result = await resolveGatewayPasswordSecretRef({
      cfg,
      env: {},
      mode: "none",
      hasPasswordCandidate: false,
      hasTokenCandidate: false,
    });
    expect(result).toBe(cfg);
  });

  it("should return unchanged config in trusted-proxy mode", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          password: "${SECRET:my-password}",
        },
      },
    };
    const result = await resolveGatewayPasswordSecretRef({
      cfg,
      env: {},
      mode: "trusted-proxy",
      hasPasswordCandidate: false,
      hasTokenCandidate: false,
    });
    expect(result).toBe(cfg);
  });

  it("should resolve secret ref in password mode", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          password: "${SECRET:my-password}",
        },
      },
      secrets: {
        defaults: {
          "my-password": "resolved-password",
        },
      },
    };
    const result = await resolveGatewayPasswordSecretRef({
      cfg,
      env: {},
      mode: "password",
      hasPasswordCandidate: false,
      hasTokenCandidate: false,
    });
    expect(result.gateway?.auth?.password).toBe("resolved-password");
  });

  it("should resolve secret ref when no mode specified and no token", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          password: "${SECRET:my-password}",
        },
      },
      secrets: {
        defaults: {
          "my-password": "resolved-password",
        },
      },
    };
    const result = await resolveGatewayPasswordSecretRef({
      cfg,
      env: {},
      hasPasswordCandidate: false,
      hasTokenCandidate: false,
    });
    expect(result.gateway?.auth?.password).toBe("resolved-password");
  });

  it("should not resolve when has token candidate", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          password: "${SECRET:my-password}",
        },
      },
    };
    const result = await resolveGatewayPasswordSecretRef({
      cfg,
      env: {},
      hasPasswordCandidate: false,
      hasTokenCandidate: true,
    });
    expect(result).toBe(cfg);
  });
});
