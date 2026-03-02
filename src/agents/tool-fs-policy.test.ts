import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveEffectiveToolFsWorkspaceOnly, resolveToolFsConfig } from "./tool-fs-policy.js";

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

  it("resolves fs read/write allowlists from global tools.fs config", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: {
          readAllowlist: ["/tmp/read"],
          writeAllowlist: ["/tmp/write"],
        },
      },
    };
    expect(resolveToolFsConfig({ cfg, agentId: "main" })).toMatchObject({
      readAllowlist: ["/tmp/read"],
      writeAllowlist: ["/tmp/write"],
    });
  });

  it("prefers agent-specific fs read/write allowlists over global config", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: {
          readAllowlist: ["/tmp/global-read"],
          writeAllowlist: ["/tmp/global-write"],
        },
      },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: {
                readAllowlist: ["/tmp/agent-read"],
                writeAllowlist: ["/tmp/agent-write"],
              },
            },
          },
        ],
      },
    };
    expect(resolveToolFsConfig({ cfg, agentId: "main" })).toMatchObject({
      readAllowlist: ["/tmp/agent-read"],
      writeAllowlist: ["/tmp/agent-write"],
    });
  });
});
