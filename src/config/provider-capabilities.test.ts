import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "./config.js";
import { resolveProviderCapabilities } from "./provider-capabilities.js";

describe("resolveProviderCapabilities", () => {
  it("returns undefined for missing inputs", () => {
    expect(resolveProviderCapabilities({})).toBeUndefined();
    expect(
      resolveProviderCapabilities({ cfg: {} as ClawdbotConfig }),
    ).toBeUndefined();
    expect(
      resolveProviderCapabilities({ cfg: {} as ClawdbotConfig, provider: "" }),
    ).toBeUndefined();
  });

  it("normalizes and prefers per-account capabilities", () => {
    const cfg = {
      telegram: {
        capabilities: [" inlineButtons ", ""],
        accounts: {
          default: {
            capabilities: [" perAccount ", "  "],
          },
        },
      },
    } satisfies Partial<ClawdbotConfig>;

    expect(
      resolveProviderCapabilities({
        cfg: cfg as ClawdbotConfig,
        provider: "telegram",
        accountId: "default",
      }),
    ).toEqual(["perAccount"]);
  });

  it("falls back to provider capabilities when account capabilities are missing", () => {
    const cfg = {
      telegram: {
        capabilities: ["inlineButtons"],
        accounts: {
          default: {},
        },
      },
    } satisfies Partial<ClawdbotConfig>;

    expect(
      resolveProviderCapabilities({
        cfg: cfg as ClawdbotConfig,
        provider: "telegram",
        accountId: "default",
      }),
    ).toEqual(["inlineButtons"]);
  });

  it("matches account keys case-insensitively", () => {
    const cfg = {
      slack: {
        accounts: {
          Family: { capabilities: ["threads"] },
        },
      },
    } satisfies Partial<ClawdbotConfig>;

    expect(
      resolveProviderCapabilities({
        cfg: cfg as ClawdbotConfig,
        provider: "slack",
        accountId: "family",
      }),
    ).toEqual(["threads"]);
  });

  it("supports msteams capabilities", () => {
    const cfg = {
      msteams: { capabilities: [" polls ", ""] },
    } satisfies Partial<ClawdbotConfig>;

    expect(
      resolveProviderCapabilities({
        cfg: cfg as ClawdbotConfig,
        provider: "msteams",
      }),
    ).toEqual(["polls"]);
  });
});
