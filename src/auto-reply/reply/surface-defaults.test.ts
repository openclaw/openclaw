import { describe, expect, it } from "vitest";
import { resolveSurfaceDirectiveDefaults } from "./surface-defaults.js";

describe("resolveSurfaceDirectiveDefaults", () => {
  it("resolves defaults for normalized surface names", () => {
    const resolved = resolveSurfaceDirectiveDefaults({
      agentCfg: {
        surfaceDefaults: {
          tui: {
            verboseDefault: "full",
            reasoningDefault: "on",
          },
        },
      },
      surface: "TUI",
    });

    expect(resolved.surfaceKey).toBe("tui");
    expect(resolved.verboseDefault).toBe("full");
    expect(resolved.reasoningDefault).toBe("on");
  });

  it("falls back to provider when surface is absent", () => {
    const resolved = resolveSurfaceDirectiveDefaults({
      agentCfg: {
        surfaceDefaults: {
          discord: {
            verboseDefault: "off",
            reasoningDefault: "off",
          },
        },
      },
      provider: "DISCORD",
    });

    expect(resolved.surfaceKey).toBe("discord");
    expect(resolved.verboseDefault).toBe("off");
    expect(resolved.reasoningDefault).toBe("off");
  });

  it("matches mixed-case config keys via normalized lookup", () => {
    const resolved = resolveSurfaceDirectiveDefaults({
      agentCfg: {
        surfaceDefaults: {
          Discord: {
            verboseDefault: "on",
            reasoningDefault: "stream",
          },
        },
      },
      surface: "discord",
    });

    expect(resolved.surfaceKey).toBe("discord");
    expect(resolved.verboseDefault).toBe("on");
    expect(resolved.reasoningDefault).toBe("stream");
  });

  it("returns no defaults for unknown surfaces without throwing", () => {
    const resolved = resolveSurfaceDirectiveDefaults({
      agentCfg: {
        surfaceDefaults: {
          tui: {
            verboseDefault: "full",
          },
        },
      },
      surface: "matrix",
    });

    expect(resolved.surfaceKey).toBe("matrix");
    expect(resolved.verboseDefault).toBeUndefined();
    expect(resolved.reasoningDefault).toBeUndefined();
  });
});
