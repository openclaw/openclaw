import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveEffectiveToolFsReadEnabled,
  resolveEffectiveToolFsWorkspaceOnly,
} from "./tool-fs-policy.js";

describe("resolveEffectiveToolFsWorkspaceOnly", () => {
  it("returns false by default when tools.fs.workspaceOnly is unset", () => {
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg: {}, agentId: "main" })).toBe(false);
  });

  it("uses global tools.fs.workspaceOnly when no agent override exists", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: true } },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(true);
  });

  it("prefers agent-specific tools.fs.workspaceOnly override over global setting", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: true } },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: false },
            },
          },
        ],
      },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(false);
  });

  it("supports agent-specific enablement when global workspaceOnly is off", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: false } },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: true },
            },
          },
        ],
      },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(true);
  });
});

describe("resolveEffectiveToolFsReadEnabled", () => {
  it("allows reads by default when no restrictive profile is configured", () => {
    expect(resolveEffectiveToolFsReadEnabled({ cfg: {}, agentId: "main" })).toBe(true);
  });

  it("disables reads for messaging profile agents without filesystem opt-in", () => {
    const cfg: OpenClawConfig = {
      tools: { profile: "messaging" },
    };
    expect(resolveEffectiveToolFsReadEnabled({ cfg, agentId: "main" })).toBe(false);
  });

  it("re-enables reads when tools.fs is configured for messaging profile agents", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "messaging",
        fs: { workspaceOnly: false },
      },
    };
    expect(resolveEffectiveToolFsReadEnabled({ cfg, agentId: "main" })).toBe(true);
  });
});
