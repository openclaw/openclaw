import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("config schema regressions", () => {
  it("accepts nested telegram groupPolicy overrides", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              groupPolicy: "open",
              topics: {
                "42": {
                  groupPolicy: "disabled",
                },
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch fallback "voyage"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            fallback: "voyage",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch provider "mistral"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "mistral",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts safe iMessage remoteHost", () => {
    const res = validateConfigObject({
      channels: {
        imessage: {
          remoteHost: "bot@gateway-host",
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts channels.whatsapp.enabled", () => {
    const res = validateConfigObject({
      channels: {
        whatsapp: {
          enabled: true,
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects unsafe iMessage remoteHost", () => {
    const res = validateConfigObject({
      channels: {
        imessage: {
          remoteHost: "bot@gateway-host -oProxyCommand=whoami",
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.imessage.remoteHost");
    }
  });

  it("accepts iMessage attachment root patterns", () => {
    const res = validateConfigObject({
      channels: {
        imessage: {
          attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
          remoteAttachmentRoots: ["/Volumes/relay/attachments"],
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts string values for agents defaults model inputs", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-6",
          imageModel: "openai/gpt-4.1-mini",
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects relative iMessage attachment roots", () => {
    const res = validateConfigObject({
      channels: {
        imessage: {
          attachmentRoots: ["./attachments"],
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.imessage.attachmentRoots.0");
    }
  });

  it('accepts legacy gateway.mode="gateway" (alias of local)', () => {
    const res = validateConfigObject({
      gateway: {
        mode: "gateway",
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.gateway?.mode).toBe("local");
    }
  });

  it('accepts legacy gateway.bind="0.0.0.0" by mapping to customBindHost', () => {
    const res = validateConfigObject({
      gateway: {
        bind: "0.0.0.0",
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.gateway?.bind).toBe("custom");
      expect(res.config.gateway?.customBindHost).toBe("0.0.0.0");
    }
  });

  it("rejects legacy gateway.bind IPv4 when gateway.customBindHost conflicts", () => {
    const res = validateConfigObject({
      gateway: {
        bind: "0.0.0.0",
        customBindHost: "127.0.0.1",
      },
    });

    expect(res.ok).toBe(false);
  });
});
