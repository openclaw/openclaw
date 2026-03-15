import { describe, expect, test } from "vitest";
import { DEFAULT_TOOL_ALLOW } from "./sandbox/constants.js";
import { applyToolPolicyPipeline } from "./tool-policy-pipeline.js";

type DummyTool = { name: string };

describe("tool-policy-pipeline", () => {
  test("strips allowlists that would otherwise disable core tools", () => {
    const tools = [{ name: "exec" }, { name: "plugin_tool" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      // oxlint-disable-next-line typescript/no-explicit-any
      tools: tools as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      toolMeta: (t: any) => (t.name === "plugin_tool" ? { pluginId: "foo" } : undefined),
      warn: () => {},
      steps: [
        {
          policy: { allow: ["plugin_tool"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    const names = filtered.map((t) => (t as unknown as DummyTool).name).toSorted();
    expect(names).toEqual(["exec", "plugin_tool"]);
  });

  test("warns about unknown allowlist entries", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];
    applyToolPolicyPipeline({
      // oxlint-disable-next-line typescript/no-explicit-any
      tools: tools as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["wat"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("unknown entries (wat)");
  });

  test("warns gated core tools as unavailable instead of plugin-only unknowns", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];
    applyToolPolicyPipeline({
      // oxlint-disable-next-line typescript/no-explicit-any
      tools: tools as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["apply_patch"] },
          label: "tools.profile (coding)",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("unknown entries (apply_patch)");
    expect(warnings[0]).toContain(
      "shipped core tools but unavailable in the current runtime/provider/model/config",
    );
    expect(warnings[0]).not.toContain("unless the plugin is enabled");
  });

  test("applies allowlist filtering when core tools are explicitly listed", () => {
    const tools = [{ name: "exec" }, { name: "process" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      // oxlint-disable-next-line typescript/no-explicit-any
      tools: tools as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["exec"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    expect(filtered.map((t) => (t as unknown as DummyTool).name)).toEqual(["exec"]);
  });

  /**
   * Reproduces issue #41757: with sandbox enabled, the sandbox step uses
   * DEFAULT_TOOL_ALLOW (or tools.sandbox.tools.allow) and filters the tool list.
   * Plugin tools (e.g. start_task) that are in the agent's tools.alsoAllow are
   * not in DEFAULT_TOOL_ALLOW, so they get removed even though the agent
   * explicitly allowed them.
   */
  test("sandbox step removes plugin tool not in DEFAULT_TOOL_ALLOW (#41757 repro)", () => {
    const coreAndPluginTools = [
      { name: "read" },
      { name: "exec" },
      { name: "sessions_spawn" },
      { name: "start_task" }, // plugin tool, in agent tools.alsoAllow, not in DEFAULT_TOOL_ALLOW
    ] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      // oxlint-disable-next-line typescript/no-explicit-any
      tools: coreAndPluginTools as any,
      toolMeta: (t) =>
        (t as unknown as DummyTool).name === "start_task" ? { pluginId: "start-task" } : undefined,
      warn: () => {},
      steps: [
        // Simulate profile/agent step: allow all of these (including start_task via alsoAllow).
        {
          policy: { allow: ["read", "exec", "sessions_spawn", "start_task"] },
          label: "agent tools.allow + alsoAllow",
          stripPluginOnlyAllowlist: true,
        },
        // Sandbox step: default allow list does not include plugin tool names.
        {
          policy: { allow: [...DEFAULT_TOOL_ALLOW] },
          label: "sandbox tools.allow",
        },
      ],
    });
    const names = filtered.map((t) => (t as unknown as DummyTool).name);
    expect(names).toContain("read");
    expect(names).toContain("exec");
    expect(names).not.toContain("start_task");
  });

  /**
   * After #41757 fix: when sandbox step uses a policy whose allow list is merged
   * with agent tools.alsoAllow (e.g. DEFAULT_TOOL_ALLOW + start_task), the
   * plugin tool is retained instead of being dropped.
   */
  test("sandbox step retains plugin tool when allow is merged with alsoAllow (#41757 fix)", () => {
    const coreAndPluginTools = [
      { name: "read" },
      { name: "exec" },
      { name: "sessions_spawn" },
      { name: "start_task" },
    ] as unknown as DummyTool[];
    const mergedAllow = [...DEFAULT_TOOL_ALLOW, "start_task"];
    const filtered = applyToolPolicyPipeline({
      // oxlint-disable-next-line typescript/no-explicit-any
      tools: coreAndPluginTools as any,
      toolMeta: (t) =>
        (t as unknown as DummyTool).name === "start_task" ? { pluginId: "start-task" } : undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["read", "exec", "sessions_spawn", "start_task"] },
          label: "agent tools.allow + alsoAllow",
          stripPluginOnlyAllowlist: true,
        },
        {
          policy: { allow: mergedAllow },
          label: "sandbox tools.allow (merged with alsoAllow)",
        },
      ],
    });
    const names = filtered.map((t) => (t as unknown as DummyTool).name);
    expect(names).toContain("read");
    expect(names).toContain("exec");
    expect(names).toContain("start_task");
  });
});
