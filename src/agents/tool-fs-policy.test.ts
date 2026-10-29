// Tool filesystem policy tests cover how global and agent-specific tool
// profiles decide workspace-only access and root expansion.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withCapturedOpenClawToolsFsPolicy } from "./openclaw-tools.fs-policy.js";
import {
  resolveEffectiveToolFsRootExpansionAllowed,
  resolveEffectiveToolFsWorkspaceOnly,
  resolveOpenClawToolsFsPolicy,
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

describe("resolveEffectiveToolFsRootExpansionAllowed", () => {
  it("allows root expansion by default when no restrictive profile is configured", () => {
    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg: {}, agentId: "main" })).toBe(true);
  });

  it("disables root expansion for messaging profile agents without filesystem opt-in", () => {
    const cfg: OpenClawConfig = {
      tools: { profile: "messaging" },
    };
    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "main" })).toBe(false);
  });

  it("does not re-enable root expansion from tools.fs alone under messaging profile (#47487)", () => {
    // A messaging profile needs an explicit read opt-in; merely configuring
    // tools.fs should not widen filesystem reach.
    const cfg: OpenClawConfig = {
      tools: {
        profile: "messaging",
        fs: { workspaceOnly: false },
      },
    };
    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "main" })).toBe(false);
  });

  it("does not treat an explicit tools.fs block as a filesystem opt-in (#47487)", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "messaging",
        fs: {},
      },
    };
    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "main" })).toBe(false);
  });

  it("re-enables root expansion when alsoAllow explicitly includes read (#47487)", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "messaging",
        alsoAllow: ["read"],
        fs: { workspaceOnly: false },
      },
    };
    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "main" })).toBe(true);
  });

  it("keeps root expansion disabled when tools.fs only restricts access to the workspace", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "messaging",
        fs: { workspaceOnly: true },
      },
    };
    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "main" })).toBe(false);
  });

  it("prefers agent profile overrides over the global profile in both directions", () => {
    const cfg: OpenClawConfig = {
      tools: { profile: "messaging" },
      agents: {
        list: [
          { id: "coder", tools: { profile: "coding" } },
          { id: "messenger", tools: { profile: "messaging" } },
        ],
      },
    };

    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "coder" })).toBe(true);

    const invertedCfg: OpenClawConfig = {
      tools: { profile: "coding" },
      agents: {
        list: [{ id: "messenger", tools: { profile: "messaging" } }],
      },
    };

    expect(
      resolveEffectiveToolFsRootExpansionAllowed({ cfg: invertedCfg, agentId: "messenger" }),
    ).toBe(false);
  });

  it("uses agent alsoAllow in place of global alsoAllow when resolving expansion", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "messaging",
        alsoAllow: ["read"],
      },
      agents: {
        list: [
          {
            id: "messenger",
            tools: {
              alsoAllow: ["message"],
            },
          },
        ],
      },
    };

    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "messenger" })).toBe(false);
  });

  it("honors agent workspaceOnly overrides over global fs opt-in", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "messaging",
        fs: { workspaceOnly: false },
      },
      agents: {
        list: [
          {
            id: "messenger",
            tools: {
              fs: { workspaceOnly: true },
            },
          },
        ],
      },
    };

    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "messenger" })).toBe(false);
  });
});

describe("resolveOpenClawToolsFsPolicy", () => {
  it("lets an explicit session permission mode decide and pins its root", () => {
    expect(
      resolveOpenClawToolsFsPolicy({
        cfg: { tools: { fs: { workspaceOnly: false } } },
        agentId: "main",
        sessionPermissionPolicy: { mode: "workspace", root: "/work/root" },
      }),
    ).toEqual({ workspaceOnly: true, root: "/work/root" });
    expect(
      resolveOpenClawToolsFsPolicy({
        cfg: { tools: { fs: { workspaceOnly: true } } },
        agentId: "main",
        sessionPermissionPolicy: { mode: "full", root: "/work/root" },
      }),
    ).toBeUndefined();
  });

  it("keeps the subagent attachment root readable without widening the workspace", () => {
    expect(
      resolveOpenClawToolsFsPolicy({
        cfg: { tools: { fs: { workspaceOnly: true } } },
        agentId: "main",
        attachmentReadRoot: "/state/attachments/child",
      }),
    ).toEqual({ workspaceOnly: true, readOnlyRoots: ["/state/attachments/child"] });
    expect(
      resolveOpenClawToolsFsPolicy({ cfg: {}, agentId: "main", attachmentReadRoot: "/x" }),
    ).toBeUndefined();
  });
});

vi.mock("./subagents/subagent-attachment-paths.js", () => ({
  subagentAttachmentRootForRun: () => "/attachments",
}));

describe("withCapturedOpenClawToolsFsPolicy", () => {
  it("derives a restricted policy without mutating frozen caller options", () => {
    const input = Object.freeze({ config: { tools: { fs: { workspaceOnly: true } } } });
    const captured = withCapturedOpenClawToolsFsPolicy(input, "main");
    expect(captured).not.toBe(input);
    expect(captured.config).toBe(input.config);
    expect(input).not.toHaveProperty("fsPolicy");
    expect(captured.fsPolicy).toEqual({ workspaceOnly: true, readOnlyRoots: ["/attachments"] });
  });

  it("preserves an explicit policy and other caller options", () => {
    const fsPolicy = { workspaceOnly: true as const, root: "/workspace" };
    const input = Object.freeze({ fsPolicy, workspaceDir: "/workspace" });
    const captured = withCapturedOpenClawToolsFsPolicy(input, "main");
    expect(captured).not.toBe(input);
    expect(captured.fsPolicy).toBe(fsPolicy);
    expect(captured.workspaceDir).toBe("/workspace");
  });

  it("keeps omitted unrestricted options unrestricted", () => {
    expect(withCapturedOpenClawToolsFsPolicy(undefined, "main").fsPolicy).toBeUndefined();
  });
});
