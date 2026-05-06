import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  collectToolCompanionAllowlistWarnings,
  maybeRepairToolCompanionAllowlists,
} from "./tool-companion-allowlist-repair.js";

describe("tool companion allowlist repair", () => {
  it("warns when restricted profiles allow exec/write without companion tools", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "messaging",
        alsoAllow: ["exec", "read", "write", "session_status"],
        exec: { security: "allowlist", ask: "on-miss" },
        fs: { workspaceOnly: true },
      },
    };

    const warnings = collectToolCompanionAllowlistWarnings(cfg, "openclaw doctor --fix");

    expect(warnings.join("\n")).toContain("tools.alsoAllow");
    expect(warnings.join("\n")).toContain('"process"');
    expect(warnings.join("\n")).toContain('"edit"');
    expect(warnings.join("\n")).toContain("openclaw doctor --fix");
  });

  it("repairs explicit global companion omissions without changing unrelated tools", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "messaging",
        alsoAllow: ["exec", "read", "write", "web_fetch"],
        exec: { security: "allowlist", ask: "on-miss" },
        fs: { workspaceOnly: true },
      },
    };

    const result = maybeRepairToolCompanionAllowlists(cfg);

    expect(result.config.tools?.alsoAllow).toEqual([
      "exec",
      "read",
      "write",
      "web_fetch",
      "process",
      "edit",
    ]);
    expect(result.changes).toEqual(['Added "process", "edit" to tools.alsoAllow.']);
  });

  it("uses inherited global exec/fs sections for agent-level allowlists", () => {
    const cfg: OpenClawConfig = {
      tools: {
        exec: { security: "allowlist" },
        fs: { workspaceOnly: true },
      },
      agents: {
        list: [
          {
            id: "zollie",
            tools: {
              profile: "messaging",
              alsoAllow: ["exec", "write"],
            },
          },
        ],
      },
    };

    const result = maybeRepairToolCompanionAllowlists(cfg);

    expect(result.config.agents?.list?.[0]?.tools?.alsoAllow).toEqual([
      "exec",
      "write",
      "process",
      "edit",
    ]);
  });

  it("does not rewrite complete groups or configs without explicit partial opt-ins", () => {
    const grouped: OpenClawConfig = {
      tools: {
        profile: "messaging",
        alsoAllow: ["group:runtime", "group:fs"],
        exec: {},
        fs: {},
      },
    };
    const implicitOnly: OpenClawConfig = {
      tools: {
        profile: "messaging",
        exec: {},
        fs: {},
      },
    };

    expect(maybeRepairToolCompanionAllowlists(grouped).changes).toEqual([]);
    expect(maybeRepairToolCompanionAllowlists(implicitOnly).changes).toEqual([]);
  });

  it("does not warn for coding profiles that already include companion tools", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "coding",
        alsoAllow: ["exec", "write"],
        exec: {},
        fs: {},
      },
    };

    expect(collectToolCompanionAllowlistWarnings(cfg, "openclaw doctor --fix")).toEqual([]);
    expect(maybeRepairToolCompanionAllowlists(cfg).changes).toEqual([]);
  });
});
