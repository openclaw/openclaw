// Mattermost token summary tests cover status-all credential source counting and safe display output.
import { describe, expect, it } from "vitest";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import {
  formatTokenHint,
  summarizeTokenConfig,
  type ChannelAccountTokenSummaryRow,
} from "./channels-token-summary.js";

function tokenRow(params: {
  account: Record<string, unknown>;
  snapshot?: Partial<ChannelAccountSnapshot>;
  enabled?: boolean;
}): ChannelAccountTokenSummaryRow {
  return {
    account: params.account,
    enabled: params.enabled ?? true,
    snapshot: {
      accountId: "primary",
      ...params.snapshot,
    } as ChannelAccountSnapshot,
  };
}

function summarize(accounts: ChannelAccountTokenSummaryRow[]) {
  return summarizeTokenConfig({ accounts, showSecrets: false });
}

describe("summarizeTokenConfig", () => {
  it("does not require appToken for bot-token-only channels", () => {
    const summary = summarize([
      tokenRow({
        account: {
          botToken: "bot-token-value",
          baseUrl: "https://mm.example.com",
        },
        snapshot: { botTokenSource: "config" },
      }),
    ]);

    expect(summary.state).toBe("ok");
    expect(summary.detail).toContain("bot token config");
    expect(summary.detail).not.toContain("need bot+app");
  });

  it("keeps bot+app requirement when both fields exist", () => {
    const summary = summarize([
      tokenRow({
        account: {
          botToken: "bot-token",
          appToken: "",
        },
      }),
    ]);

    expect(summary.state).toBe("warn");
    expect(summary.detail).toContain("need bot+app");
  });

  it("reports configured-but-unavailable Slack credentials as warn", () => {
    const summary = summarize([
      tokenRow({
        account: {
          configured: true,
          botToken: "",
          appToken: "",
          botTokenSource: "config",
          appTokenSource: "config",
          botTokenStatus: "configured_unavailable",
          appTokenStatus: "configured_unavailable",
        },
        snapshot: {
          botTokenSource: "config",
          appTokenSource: "config",
        },
      }),
    ]);

    expect(summary.state).toBe("warn");
    expect(summary.detail).toContain("unavailable in this command path");
  });

  it("treats status-only available HTTP credentials as resolved", () => {
    const summary = summarize([
      tokenRow({
        account: {
          mode: "http",
          botToken: "",
          signingSecret: "", // pragma: allowlist secret
          botTokenSource: "config",
          signingSecretSource: "config", // pragma: allowlist secret
          botTokenStatus: "available",
          signingSecretStatus: "available", // pragma: allowlist secret
        },
        snapshot: {
          botTokenSource: "config",
          signingSecretSource: "config", // pragma: allowlist secret
        },
      }),
    ]);

    expect(summary.state).toBe("ok");
    expect(summary.detail).toContain("credentials ok");
  });

  it("treats Slack HTTP signing-secret availability as required config", () => {
    const summary = summarize([
      tokenRow({
        account: {
          mode: "http",
          botToken: "xoxb-http",
          signingSecret: "", // pragma: allowlist secret
          botTokenSource: "config",
          signingSecretSource: "config", // pragma: allowlist secret
          botTokenStatus: "available",
          signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
        },
        snapshot: {
          botTokenSource: "config",
          signingSecretSource: "config", // pragma: allowlist secret
        },
      }),
    ]);

    expect(summary.state).toBe("warn");
    expect(summary.detail).toContain("configured http credentials unavailable");
  });

  it("still reports single-token channels as ok", () => {
    const summary = summarize([
      tokenRow({
        account: {
          token: "token-value",
          tokenSource: "config",
        },
        snapshot: { tokenSource: "config" },
      }),
    ]);

    expect(summary.state).toBe("ok");
    expect(summary.detail).toContain("token config");
  });
});

describe("formatTokenHint", () => {
  it.each([
    ["sk-1234567890", "sk-1…7890 · len 13"],
    ["short", "short · len 5"],
    ["", "empty"],
  ])("redacts ASCII token %p", (token, expected) => {
    expect(formatTokenHint(token, { showSecrets: true })).toBe(expected);
  });

  it("falls back to a fingerprint when secrets are hidden", () => {
    const hint = formatTokenHint("sk-1234567890", { showSecrets: false });
    expect(hint).toMatch(/^sha256:[a-f0-9]{8} · len 13$/);
  });

  it("does not split UTF-16 surrogate pairs at hint boundaries", () => {
    // Head boundary lands inside a surrogate pair.
    const headSplit = "abc😀" + "x".repeat(10);
    expect(formatTokenHint(headSplit, { showSecrets: true })).toBe("abc…xxxx · len 15");

    // Tail boundary lands inside a surrogate pair.
    const tailSplit = "x".repeat(10) + "😀abc";
    expect(formatTokenHint(tailSplit, { showSecrets: true })).toBe("xxxx…abc · len 15");

    // Short value is shown in full even with astral characters.
    expect(formatTokenHint("a😀b", { showSecrets: true })).toBe("a😀b · len 4");

    // No isolated surrogates are emitted anywhere.
    const all = [headSplit, tailSplit, "a😀b"]
      .map((value) => formatTokenHint(value, { showSecrets: true }))
      .join("");
    expect(() => encodeURIComponent(all)).not.toThrow();
    expect(all).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(all).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
