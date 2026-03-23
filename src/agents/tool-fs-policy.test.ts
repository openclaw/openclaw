import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "./tool-fs-policy.js";

describe("resolveEffectiveToolFsWorkspaceOnly", () => {
  it("returns true by default when tools.fs.workspaceOnly is unset (secure default)", () => {
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg: {}, agentId: "main" })).toBe(true);
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
