import { describe, expect, it } from "vitest";
import { resolveMessageSecretScope } from "./message-secret-scope.js";

describe("resolveMessageSecretScope", () => {
  it("prefers explicit channel/account inputs", () => {
    expect(
      resolveMessageSecretScope({
        channel: "Discord",
        accountId: "Ops",
      }),
    ).toEqual({
      channel: "discord",
      accountId: "ops",
    });
  });

  it("infers channel from a prefixed target", () => {
    expect(
      resolveMessageSecretScope({
        target: "telegram:12345",
      }),
    ).toEqual({
      channel: "telegram",
    });
  });

  it("infers a shared channel from target arrays", () => {
    expect(
      resolveMessageSecretScope({
        targets: ["discord:one", "discord:two"],
      }),
    ).toEqual({
      channel: "discord",
    });
  });

  it("does not infer a channel when target arrays mix channels", () => {
    expect(
      resolveMessageSecretScope({
        targets: ["discord:one", "slack:two"],
      }),
    ).toEqual({});
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
});
