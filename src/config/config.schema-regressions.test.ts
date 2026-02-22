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

  it("accepts memorySearch.local.gpu = false (CPU only)", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "local",
            local: {
              modelPath: "/path/to/model.gguf",
              gpu: false,
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch.local.gpu = "metal"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "local",
            local: {
              modelPath: "/path/to/model.gguf",
              gpu: "metal",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects memorySearch.local.gpu with invalid value", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "local",
            local: {
              gpu: "opengl",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it('accepts memorySearch.local.gpu = "auto"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "local",
            local: { gpu: "auto" },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch.local.gpu = "cuda"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "local",
            local: { gpu: "cuda" },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch.local.gpu = "vulkan"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "local",
            local: { gpu: "vulkan" },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });
});
