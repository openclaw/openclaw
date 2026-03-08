import { describe, expect, it } from "vitest";
import { type OpenClawConfig, DEFAULT_GATEWAY_PORT } from "../config/config.js";
import {
  buildDefaultImapHookUrl,
  DEFAULT_IMAP_FOLDER,
  DEFAULT_IMAP_MAX_BYTES,
  DEFAULT_IMAP_POLL_INTERVAL_SECONDS,
  DEFAULT_IMAP_QUERY,
  MIN_IMAP_POLL_INTERVAL_SECONDS,
  resolveImapHookRuntimeConfig,
} from "./imap.js";

const baseConfig = {
  hooks: {
    token: "hook-token",
    imap: {
      account: "myaccount",
      allowedSenders: ["owner@example.com"],
    },
  },
} satisfies OpenClawConfig;

describe("imap hook config", () => {
  it("builds default hook url", () => {
    expect(buildDefaultImapHookUrl("/hooks", DEFAULT_GATEWAY_PORT)).toBe(
      `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/hooks/imap`,
    );
  });

  it("resolves runtime config with defaults", async () => {
    const result = await resolveImapHookRuntimeConfig(baseConfig, {
      allowedSenders: ["owner@example.com"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.account).toBe("myaccount");
      expect(result.value.folder).toBe(DEFAULT_IMAP_FOLDER);
      expect(result.value.pollIntervalSeconds).toBe(DEFAULT_IMAP_POLL_INTERVAL_SECONDS);
      expect(result.value.includeBody).toBe(true);
      expect(result.value.maxBytes).toBe(DEFAULT_IMAP_MAX_BYTES);
      expect(result.value.markSeen).toBe(true);
      expect(result.value.query).toBe(DEFAULT_IMAP_QUERY);
      expect(result.value.hookUrl).toBe(`http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/hooks/imap`);
      expect(result.value.allowedSenders).toContain("owner@example.com");
    }
  });

  it("fails without hook token", async () => {
    const result = await resolveImapHookRuntimeConfig(
      { hooks: { imap: { account: "myaccount", allowedSenders: ["owner@example.com"] } } },
      { allowedSenders: ["owner@example.com"] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("hooks.token missing");
    }
  });

  it("fails without account", async () => {
    const result = await resolveImapHookRuntimeConfig(
      { hooks: { token: "tok", imap: { allowedSenders: ["owner@example.com"] } } },
      { allowedSenders: ["owner@example.com"] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("imap account required");
    }
  });

  it("fails without allowed senders", async () => {
    const result = await resolveImapHookRuntimeConfig(baseConfig, {
      allowedSenders: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("hooks.imap.allowedSenders required");
    }
  });

  it("applies overrides", async () => {
    const result = await resolveImapHookRuntimeConfig(baseConfig, {
      folder: "Sent",
      pollIntervalSeconds: 60,
      includeBody: false,
      maxBytes: 5000,
      markSeen: false,
      query: "from admin",
      allowedSenders: ["owner@example.com"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.folder).toBe("Sent");
      expect(result.value.pollIntervalSeconds).toBe(60);
      expect(result.value.includeBody).toBe(false);
      expect(result.value.maxBytes).toBe(5000);
      expect(result.value.markSeen).toBe(false);
      expect(result.value.query).toBe("from admin");
    }
  });

  it("clamps poll interval to minimum", async () => {
    const result = await resolveImapHookRuntimeConfig(baseConfig, {
      pollIntervalSeconds: 1,
      allowedSenders: ["owner@example.com"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pollIntervalSeconds).toBe(MIN_IMAP_POLL_INTERVAL_SECONDS);
    }
  });

  it("respects himalayaConfig override", async () => {
    const result = await resolveImapHookRuntimeConfig(baseConfig, {
      himalayaConfig: "/custom/path.toml",
      allowedSenders: ["owner@example.com"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.himalayaConfig).toBe("/custom/path.toml");
    }
  });

  it("resolves hookUrl from config when set", async () => {
    const cfg: OpenClawConfig = {
      hooks: {
        token: "hook-token",
        imap: {
          account: "myaccount",
          hookUrl: "http://example.com/hooks/imap",
          allowedSenders: ["owner@example.com"],
        },
      },
    };
    const result = await resolveImapHookRuntimeConfig(cfg, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hookUrl).toBe("http://example.com/hooks/imap");
    }
  });
});
