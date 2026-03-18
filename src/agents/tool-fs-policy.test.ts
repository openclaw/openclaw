import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveEffectiveToolFsEditWorkspaceOnly,
  resolveEffectiveToolFsReadWorkspaceOnly,
  resolveEffectiveToolFsWriteWorkspaceOnly,
} from "./tool-fs-policy.js";

describe("resolveEffectiveToolFsReadWorkspaceOnly", () => {
  it("returns false by default when tools.fs.workspaceOnly is unset", () => {
    expect(resolveEffectiveToolFsReadWorkspaceOnly({ cfg: {}, agentId: "main" })).toBe(false);
  });

  it("uses global tools.fs.workspaceOnly when no agent override exists", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: true } },
    };
    expect(resolveEffectiveToolFsReadWorkspaceOnly({ cfg, agentId: "main" })).toBe(true);
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
    expect(resolveEffectiveToolFsReadWorkspaceOnly({ cfg, agentId: "main" })).toBe(false);
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
    expect(resolveEffectiveToolFsReadWorkspaceOnly({ cfg, agentId: "main" })).toBe(true);
  });

  it("lets agents split read/write/edit workspace boundaries independently", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: true } },
      agents: {
        list: [
          {
            id: "scout",
            tools: {
              fs: {
                readWorkspaceOnly: false,
                writeWorkspaceOnly: true,
                editWorkspaceOnly: true,
              },
            },
          },
        ],
      },
    };

    expect(resolveEffectiveToolFsReadWorkspaceOnly({ cfg, agentId: "scout" })).toBe(false);
    expect(resolveEffectiveToolFsWriteWorkspaceOnly({ cfg, agentId: "scout" })).toBe(true);
    expect(resolveEffectiveToolFsEditWorkspaceOnly({ cfg, agentId: "scout" })).toBe(true);
  });
});
