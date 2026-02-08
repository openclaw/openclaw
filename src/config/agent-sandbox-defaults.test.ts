import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./types.js";
import { applyAgentDefaults } from "./defaults.js";

describe("applyAgentDefaults (sandbox defaults)", () => {
  it("fills secure sandbox defaults when agents.defaults.sandbox is absent", () => {
    const cfg = {} satisfies OpenClawConfig;
    const next = applyAgentDefaults(cfg);

    expect(next.agents?.defaults?.sandbox?.mode).toBe("non-main");
    expect(next.agents?.defaults?.sandbox?.scope).toBe("session");
    expect(next.agents?.defaults?.sandbox?.workspaceAccess).toBe("none");
    expect(next.agents?.defaults?.sandbox?.docker?.network).toBe("none");
  });

  it("does not override user-provided sandbox settings", () => {
    const cfg = {
      agents: {
        defaults: {
          sandbox: {
            mode: "off",
            scope: "shared",
            workspaceAccess: "rw",
            docker: { network: "bridge" },
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyAgentDefaults(cfg);

    expect(next.agents?.defaults?.sandbox).toEqual(cfg.agents.defaults.sandbox);
  });
});
