import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import {
  resolveEffectiveToolFsRootExpansionAllowed,
  resolveEffectiveToolFsWorkspaceOnly,
} from "./tool-fs-policy.js";

function policy(tools: OpenClawConfig["tools"], agentTools?: AgentToolsConfig) {
  const cfg: OpenClawConfig = { tools };
  if (agentTools) {
    cfg.agents = { entries: { main: { tools: agentTools } } };
  }
  return { cfg, agentId: "main" };
}

describe("resolveEffectiveToolFsWorkspaceOnly", () => {
  it("returns false by default when tools.fs.workspaceOnly is unset", () => {
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg: {}, agentId: "main" })).toBe(false);
  });

  it("uses global tools.fs.workspaceOnly when no agent override exists", () => {
    expect(resolveEffectiveToolFsWorkspaceOnly(policy({ fs: { workspaceOnly: true } }))).toBe(true);
  });

  it("prefers agent-specific tools.fs.workspaceOnly override over global setting", () => {
    expect(
      resolveEffectiveToolFsWorkspaceOnly(
        policy({ fs: { workspaceOnly: true } }, { fs: { workspaceOnly: false } }),
      ),
    ).toBe(false);
  });

  it("supports agent-specific enablement when global workspaceOnly is off", () => {
    expect(
      resolveEffectiveToolFsWorkspaceOnly(
        policy({ fs: { workspaceOnly: false } }, { fs: { workspaceOnly: true } }),
      ),
    ).toBe(true);
  });
});

describe("resolveEffectiveToolFsRootExpansionAllowed", () => {
  it("allows root expansion by default when no restrictive profile is configured", () => {
    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg: {}, agentId: "main" })).toBe(true);
  });

  it("does not re-enable root expansion from tools.fs alone under messaging profile (#47487)", () => {
    expect(
      resolveEffectiveToolFsRootExpansionAllowed(
        policy({ profile: "messaging", fs: { workspaceOnly: false } }),
      ),
    ).toBe(false);
  });

  it("re-enables root expansion when alsoAllow explicitly includes read (#47487)", () => {
    expect(
      resolveEffectiveToolFsRootExpansionAllowed(
        policy({ profile: "messaging", alsoAllow: ["read"], fs: { workspaceOnly: false } }),
      ),
    ).toBe(true);
  });

  it("prefers agent profile overrides over the global profile in both directions", () => {
    expect(
      resolveEffectiveToolFsRootExpansionAllowed(
        policy({ profile: "messaging" }, { profile: "coding" }),
      ),
    ).toBe(true);
    expect(
      resolveEffectiveToolFsRootExpansionAllowed(
        policy({ profile: "coding" }, { profile: "messaging" }),
      ),
    ).toBe(false);
  });

  it("uses agent alsoAllow in place of global alsoAllow when resolving expansion", () => {
    expect(
      resolveEffectiveToolFsRootExpansionAllowed(
        policy({ profile: "messaging", alsoAllow: ["read"] }, { alsoAllow: ["message"] }),
      ),
    ).toBe(false);
  });

  it("honors agent workspaceOnly overrides over global fs opt-in", () => {
    expect(
      resolveEffectiveToolFsRootExpansionAllowed(
        policy(
          { profile: "messaging", fs: { workspaceOnly: false } },
          { fs: { workspaceOnly: true } },
        ),
      ),
    ).toBe(false);
  });
});
