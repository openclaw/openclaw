import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { listChannelSupportedActions } from "../channel-tools.js";

describe("WhatsApp actions listing", () => {
  it("includes read and readFile actions when enabled", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          actions: {
            messages: true,
            readFile: true,
            reactions: true,
            polls: true,
          },
        },
      },
    };

    const actions = listChannelSupportedActions({ cfg, channel: "whatsapp" });

    expect(actions).toContain("read");
    expect(actions).toContain("readFile");
    expect(actions).toContain("react");
    expect(actions).toContain("poll");
  });

  it("excludes read action when messages disabled", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          actions: {
            messages: false,
            readFile: true,
          },
        },
      },
    };

    const actions = listChannelSupportedActions({ cfg, channel: "whatsapp" });

    expect(actions).not.toContain("read");
    expect(actions).toContain("readFile");
  });

  it("excludes readFile action when disabled", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          actions: {
            messages: true,
            readFile: false,
          },
        },
      },
    };

    const actions = listChannelSupportedActions({ cfg, channel: "whatsapp" });

    expect(actions).toContain("read");
    expect(actions).not.toContain("readFile");
  });

  it("includes actions by default when not explicitly configured", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {},
      },
    };

    const actions = listChannelSupportedActions({ cfg, channel: "whatsapp" });

    // Actions default to enabled
    expect(actions).toContain("read");
    expect(actions).toContain("readFile");
  });
});
