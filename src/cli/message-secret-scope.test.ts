// Message secret scope tests cover CLI secret scoping for message commands.
import { describe, expect, it } from "vitest";
import { resolveMessageSecretScope } from "./message-secret-scope.js";

describe("resolveMessageSecretScope", () => {
  it("prefers explicit channel/account inputs", () => {
    expect(
      resolveMessageSecretScope({
        channel: "Signal",
        accountId: "Ops",
      }),
    ).toEqual({
      channel: "signal",
      accountId: "ops",
    });
  });

  it("infers channel from a prefixed target", () => {
    expect(
      resolveMessageSecretScope({
        target: "signal:12345",
      }),
    ).toEqual({
      channel: "signal",
    });
  });

  it("infers a shared channel from target arrays", () => {
    expect(
      resolveMessageSecretScope({
        targets: ["signal:one", "signal:two"],
      }),
    ).toEqual({
      channel: "signal",
    });
  });

  it("does not infer a channel when target arrays mix channels", () => {
    expect(
      resolveMessageSecretScope({
        targets: ["signal:one", "imessage:two"],
      }),
    ).toStrictEqual({});
  });

  it("preserves explicit custom or request-scoped channel inputs", () => {
    expect(
      resolveMessageSecretScope({
        channel: "custom-matrix",
        accountId: "Ops",
      }),
    ).toEqual({
      channel: "custom-matrix",
      accountId: "ops",
    });
  });

  it("does not infer unknown channels from non-channel target prefixes", () => {
    expect(
      resolveMessageSecretScope({
        target: "user:12345",
      }),
    ).toStrictEqual({});
  });

  it("uses fallback channel/account when direct inputs are missing", () => {
    expect(
      resolveMessageSecretScope({
        fallbackChannel: "Signal",
        fallbackAccountId: "Chat",
      }),
    ).toEqual({
      channel: "signal",
      accountId: "chat",
    });
  });

  it("preserves fallback custom channel inputs", () => {
    expect(
      resolveMessageSecretScope({
        fallbackChannel: "custom-relay",
      }),
    ).toEqual({
      channel: "custom-relay",
    });
  });

  it("falls back when channel normalizes to empty string", () => {
    expect(
      resolveMessageSecretScope({
        channel: "   ",
        fallbackChannel: "Signal",
      }),
    ).toEqual({
      channel: "signal",
    });
  });

  it("excludes reserved 'all' broadcast selector from channel scope", () => {
    expect(
      resolveMessageSecretScope({
        channel: "all",
      }),
    ).toStrictEqual({});

    expect(
      resolveMessageSecretScope({
        channel: "ALL",
        accountId: "Ops",
      }),
    ).toEqual({
      accountId: "ops",
    });

    expect(
      resolveMessageSecretScope({
        channel: "all",
        fallbackChannel: "custom-matrix",
      }),
    ).toEqual({
      channel: "custom-matrix",
    });

    expect(
      resolveMessageSecretScope({
        fallbackChannel: "all",
      }),
    ).toStrictEqual({});
  });
});
