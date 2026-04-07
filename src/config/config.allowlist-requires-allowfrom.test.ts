import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

function expectChannelAllowlistIssue(
  result: ReturnType<typeof validateConfigObject>,
  path: string | readonly string[],
) {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    const pathParts = Array.isArray(path) ? path : [path];
    expect(
      result.issues.some((issue) => pathParts.every((part) => issue.path.includes(part))),
    ).toBe(true);
  }
}

describe('dmPolicy="allowlist" requires non-empty effective allowFrom', () => {
  it.each([
    {
      name: "telegram",
      config: { telegram: { dmPolicy: "allowlist", botToken: "fake" } },
      issuePath: "channels.telegram.allowFrom",
    },
    {
      name: "signal",
      config: { signal: { dmPolicy: "allowlist" } },
      issuePath: "channels.signal.allowFrom",
    },
    {
      name: "discord",
      config: { discord: { dmPolicy: "allowlist" } },
      issuePath: ["channels.discord", "allowFrom"],
    },
    {
      name: "whatsapp",
      config: { whatsapp: { dmPolicy: "allowlist" } },
      issuePath: "channels.whatsapp.allowFrom",
    },
  ] as const)('rejects $name dmPolicy="allowlist" without allowFrom', ({ config, issuePath }) => {
    expectChannelAllowlistIssue(validateConfigObject({ channels: config }), issuePath);
  });

  it('accepts dmPolicy="pairing" without allowFrom', () => {
    const res = validateConfigObject({
      channels: { telegram: { dmPolicy: "pairing", botToken: "fake" } },
    });
    expect(res.ok).toBe(true);
  });
});

describe('account dmPolicy="allowlist" uses inherited allowFrom', () => {
  it.each([
    {
      name: "telegram",
      config: {
        telegram: {
          allowFrom: ["12345"],
          accounts: { bot1: { dmPolicy: "allowlist", botToken: "fake" } },
        },
      },
    },
    {
      name: "signal",
      config: {
        signal: { allowFrom: ["+15550001111"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    },
    {
      name: "discord",
      config: {
        discord: { allowFrom: ["123456789"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    },
    {
      name: "slack",
      config: {
        slack: {
          allowFrom: ["U123"],
          botToken: "xoxb-top",
          appToken: "xapp-top",
          accounts: {
            work: { dmPolicy: "allowlist", botToken: "xoxb-work", appToken: "xapp-work" },
          },
        },
      },
    },
    {
      name: "whatsapp",
      config: {
        whatsapp: { allowFrom: ["+15550001111"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    },
    {
      name: "imessage",
      config: {
        imessage: { allowFrom: ["alice"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    },
    {
      name: "irc",
      config: {
        irc: { allowFrom: ["nick"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    },
    {
      name: "bluebubbles",
      config: {
        bluebubbles: { allowFrom: ["sender"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    },
  ] as const)("accepts $name account allowlist when parent allowFrom exists", ({ config }) => {
    expect(validateConfigObject({ channels: config }).ok).toBe(true);
  });

  it("rejects telegram account allowlist when neither account nor parent has allowFrom", () => {
    expectChannelAllowlistIssue(
      validateConfigObject({
        channels: {
          telegram: { accounts: { bot1: { dmPolicy: "allowlist", botToken: "fake" } } },
        },
      }),
      "channels.telegram.accounts.bot1.allowFrom",
    );
  });
});
