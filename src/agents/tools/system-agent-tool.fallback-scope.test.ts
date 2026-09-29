import { describe, expect, it } from "vitest";
import { BOUND_FALLBACK_OPERATION_SCOPE_MESSAGE } from "../../system-agent/fallback-operation-scope.js";
import { hashSystemAgentOperation } from "../../system-agent/operator-approval.js";
import {
  createSystemAgentTool,
  resolveSystemAgentDirectiveTransition,
  resolveSystemAgentProposalTransition,
  type SystemAgentToolOptions,
} from "./system-agent-tool.js";

function resultText(result: unknown): string {
  // SAFETY: each tested tool branch returns a textResult with a content array.
  const blocks = (result as { content: Array<{ text?: string }> }).content;
  return blocks.map((block) => block.text ?? "").join(" ");
}

const forbidden = [
  { name: "agent", args: { action: "create_agent", agentId: "helper" } },
  { name: "team", args: { action: "create_team", coordinatorId: "ops" } },
  { name: "plugin install", args: { action: "plugin_install", spec: "clawhub:openclaw-demo" } },
  { name: "plugin uninstall", args: { action: "plugin_uninstall", pluginId: "unrelated" } },
  {
    name: "plugin artifact",
    args: { action: "plugin_activate_artifact", path: "/tmp/absent.tgz", sha256: "a".repeat(64) },
  },
  { name: "Gateway lifecycle", args: { action: "gateway_restart" } },
  { name: "default model", args: { action: "set_default_model", model: "sample/primary" } },
  { name: "guided setup", args: { action: "open_setup", target: "gateway" } },
  { name: "model sign-in", args: { action: "configure_model_provider" } },
] as const;

describe("model-facing bound fallback operation admission", () => {
  it.each(forbidden)("refuses $name before any approval, directive or effect", async ({ args }) => {
    const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
    const directiveRef: NonNullable<SystemAgentToolOptions["directiveRef"]> = {};
    const tool = createSystemAgentTool({
      surface: "gateway",
      operatorApprovalOnly: true,
      boundFallbackScope: true,
      proposalRef,
      directiveRef,
    });
    const text = resultText(await tool.execute("refuse-before-approval", args));
    expect(text).toBe(BOUND_FALLBACK_OPERATION_SCOPE_MESSAGE);
    expect(text).not.toContain("needs-approval:");
    expect(proposalRef).toEqual({});
    expect(directiveRef).toEqual({});
    expect(resolveSystemAgentProposalTransition({ args, resultText: text })).toBeNull();
    expect(resolveSystemAgentDirectiveTransition({ args, resultText: text })).toBeNull();
  });

  it("keeps an earlier allowed proposal rather than replacing or approving it", async () => {
    const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
    const tool = createSystemAgentTool({
      surface: "cli",
      boundFallbackScope: true,
      proposalRef,
    });
    const allowed = { action: "config_set", path: "env.vars.SAMPLE", value: "local" };
    expect(resultText(await tool.execute("allowed", allowed))).toContain("needs-approval:");
    const staged = { ...proposalRef };
    expect(resultText(await tool.execute("denied", { action: "gateway_restart" }))).toBe(
      BOUND_FALLBACK_OPERATION_SCOPE_MESSAGE,
    );
    expect(proposalRef).toEqual(staged);
    expect(staged.current).toBe(
      hashSystemAgentOperation({ kind: "config-set", path: "env.vars.SAMPLE", value: "local" }),
    );
  });

  it("still stages guarded config and SecretRef without performing them", async () => {
    const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
    const tool = createSystemAgentTool({
      surface: "gateway",
      boundFallbackScope: true,
      proposalRef,
    });
    for (const args of [
      { action: "config_set", path: "env.vars.SAMPLE", value: "local" },
      { action: "config_unset", path: "env.vars.SAMPLE" },
      { action: "config_set_ref", path: "models.providers.sample.apiKey", envVar: "SAMPLE_KEY" },
    ]) {
      proposalRef.current = undefined;
      proposalRef.operation = undefined;
      expect(resultText(await tool.execute("allowed-config", args))).toContain("needs-approval:");
      expect(proposalRef.current).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("advertises only executable actions and fields for the verified fallback", () => {
    const scoped = createSystemAgentTool({ surface: "gateway", boundFallbackScope: true });
    const schema = JSON.stringify(scoped.parameters);
    for (const action of [
      ...forbidden.map(({ args }) => args.action),
      "connect_channel",
      "configure_gateway",
      "import_memory",
      "plugin_activate_artifact",
    ]) {
      expect(schema).not.toContain('"' + action + '"');
      expect(scoped.description).not.toContain(action);
    }
    for (const action of [
      "status",
      "plugin_list",
      "gateway_status",
      "config_set",
      "config_set_ref",
    ]) {
      expect(schema).toContain('"' + action + '"');
      expect(scoped.description).toContain(action);
    }
    const primary = createSystemAgentTool({ surface: "gateway" });
    expect(JSON.stringify(primary.parameters)).toContain('"plugin_install"');
    expect(primary.description).toContain("plugin_install");
  });

  it("does not change independently verified primary proposal authority", async () => {
    const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
    const tool = createSystemAgentTool({ surface: "gateway", proposalRef });
    expect(tool.description).not.toContain("Verified fallback:");
    const text = resultText(
      await tool.execute("primary", { action: "create_agent", agentId: "helper" }),
    );
    expect(text).toContain("needs-approval:");
    expect(proposalRef.current).toBe(
      hashSystemAgentOperation({ kind: "create-agent", agentId: "helper" }),
    );
  });
});
