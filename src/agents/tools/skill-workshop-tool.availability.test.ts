import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillLibraryAuthoringCapability } from "../../skills/library/authoring.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOpenClawCodingTools } from "../agent-tools.js";
import {
  applyEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
} from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { createAgentToolsSandboxContext } from "../test-helpers/agent-tools-sandbox-context.js";
import { buildEmptyExplicitToolAllowlistError } from "../tool-allowlist-guard.js";

vi.mock("../openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

describe("Workshop construction and runtime allowlist", () => {
  it.each([
    { label: "host", sandboxed: false, authorizedLibrary: false },
    { label: "sandbox", sandboxed: true, authorizedLibrary: false },
    { label: "authorized library", sandboxed: true, authorizedLibrary: true },
  ])("resolves a minimal-profile $label turn", async ({ sandboxed, authorizedLibrary }) => {
    const state = await createOpenClawTestState({
      prefix: "openclaw-workshop-availability-",
      applyEnv: true,
    });
    onTestFinished(async () => await state.cleanup());
    const config: OpenClawConfig = {
      agents: {
        entries: {
          main: {
            default: true,
            workspace: state.workspaceDir,
            sandbox: { mode: sandboxed ? "all" : "off" },
            tools: { profile: "minimal", alsoAllow: ["skill_workshop"] },
          },
        },
      },
    };
    const libraryAuthoring: SkillLibraryAuthoringCapability | undefined = authorizedLibrary
      ? {
          target: "personal",
          defaultTarget: "personal",
          multipleProfiles: true,
          bind: () => {},
          invoke: async () => {
            throw new Error("This test only constructs the library tool");
          },
        }
      : undefined;
    const constructionPlan = resolveEmbeddedAttemptToolConstructionPlan({
      toolsEnabled: true,
      toolsAllow: ["skill_workshop"],
    });
    const tools = applyEmbeddedAttemptToolsAllow(
      createOpenClawCodingTools({
        config,
        agentId: "main",
        sessionKey: "agent:main:cron:workshop-review",
        workspaceDir: state.workspaceDir,
        agentDir: state.agentDir(),
        runtimeToolAllowlist: ["skill_workshop"],
        toolConstructionPlan: constructionPlan.codingToolConstructionPlan,
        wrapBeforeToolCallHook: false,
        skillWorkshop: { libraryAuthoring },
        ...(sandboxed
          ? { sandbox: createAgentToolsSandboxContext({ workspaceDir: state.workspaceDir }) }
          : {}),
      }),
      ["skill_workshop"],
    );
    const guardInput = {
      sources: [{ label: "runtime toolsAllow", entries: ["skill_workshop"] }],
      hasCallableTools: tools.length > 0,
      toolsEnabled: true,
      skillWorkshop: { sandboxed, libraryAuthoring },
    };
    const error = buildEmptyExplicitToolAllowlistError(guardInput);

    if (sandboxed && !authorizedLibrary) {
      expect(tools).toEqual([]);
      expect(error?.message).toContain("sandboxed run without library-authoring authority");
      expect(error?.message).toContain("non-sandboxed session");
      expect(error?.message).not.toContain("no registered tools matched");
      expect(error?.message).not.toContain("enable the plugin");
      return;
    }
    expect(error).toBeNull();
    expect(tools.map((tool) => tool.name)).toEqual(["skill_workshop"]);
    if (!authorizedLibrary) {
      expect(
        (await tools[0]?.execute("list-proposals", { action: "list" }))?.details,
      ).toMatchObject({ proposals: [] });
    }
  });
});
