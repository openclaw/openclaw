import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { runSecurityAudit } from "./audit.js";

describe("security audit", () => {
  it("flags non-loopback bind without auth as critical", async () => {
    const cfg: ClawdbotConfig = {
      gateway: {
        bind: "lan",
        auth: {},
      },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(
      res.findings.some((f) => f.checkId === "gateway.bind_no_auth" && f.severity === "critical"),
    ).toBe(true);
  });

  it("flags logging.redactSensitive=off", async () => {
    const cfg: ClawdbotConfig = {
      logging: { redactSensitive: "off" },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "logging.redact_off", severity: "warn" }),
      ]),
    );
  });

  it("flags tools.elevated allowFrom wildcard as critical", async () => {
    const cfg: ClawdbotConfig = {
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["*"] },
        },
      },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "tools.elevated.allowFrom.whatsapp.wildcard",
          severity: "critical",
        }),
      ]),
    );
  });

  it("flags remote browser control without token as critical", async () => {
    const prev = process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN;
    delete process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN;
    try {
      const cfg: ClawdbotConfig = {
        browser: {
          controlUrl: "http://example.com:18791",
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: false,
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ checkId: "browser.control_remote_no_token", severity: "critical" }),
        ]),
      );
    } finally {
      if (prev === undefined) delete process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN;
      else process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN = prev;
    }
  });

  it("warns when browser control token matches gateway auth token", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    const cfg: ClawdbotConfig = {
      gateway: { auth: { token } },
      browser: { controlUrl: "https://browser.example.com", controlToken: token },
    };

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "browser.control_token_reuse_gateway_token",
          severity: "warn",
        }),
      ]),
    );
  });

  it("warns when remote browser control uses HTTP", async () => {
    const prev = process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN;
    delete process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN;
    try {
      const cfg: ClawdbotConfig = {
        browser: {
          controlUrl: "http://example.com:18791",
          controlToken: "0123456789abcdef01234567",
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: false,
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ checkId: "browser.control_remote_http", severity: "warn" }),
        ]),
      );
    } finally {
      if (prev === undefined) delete process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN;
      else process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN = prev;
    }
  });

  it("adds a warning when deep probe fails", async () => {
    const cfg: ClawdbotConfig = { gateway: { mode: "local" } };

    const res = await runSecurityAudit({
      config: cfg,
      deep: true,
      deepTimeoutMs: 50,
      includeFilesystem: false,
      includeChannelSecurity: false,
      probeGatewayFn: async () => ({
        ok: false,
        url: "ws://127.0.0.1:18789",
        connectLatencyMs: null,
        error: "connect failed",
        close: null,
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      }),
    });

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "gateway.probe_failed", severity: "warn" }),
      ]),
    );
  });
});
