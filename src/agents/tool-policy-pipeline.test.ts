// Tool policy pipeline tests cover profile/allowlist filtering, diagnostics,
// warning dedupe, and plugin-aware policy application.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { markFrozenClawToolAllowPolicy } from "../claws/tool-policy-runtime.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { buildDeclaredToolAllowlistContext } from "./tool-policy-declared-context.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "./tool-policy-pipeline.js";
import { resolveToolProfilePolicy } from "./tool-policy.js";

const { toolPolicyAuditDebug, toolPolicyAuditInfo } = vi.hoisted(() => ({
  toolPolicyAuditDebug: vi.fn(),
  toolPolicyAuditInfo: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: toolPolicyAuditDebug,
    info: toolPolicyAuditInfo,
  }),
}));

type DummyTool = { name: string };
function runAllowlistWarningStep(params: {
  allow: string[];
  label: string;
  suppressUnavailableCoreToolWarning?: boolean;
  suppressUnavailableCoreToolWarningAllowlist?: string[];
  unavailableCoreToolReason?: string;
}) {
  const warnings: string[] = [];
  const tools = [{ name: "exec" }];
  applyToolPolicyPipeline({
    tools,
    toolMeta: () => undefined,
    warn: (msg) => warnings.push(msg),
    steps: [
      {
        policy: { allow: params.allow },
        label: params.label,
        stripPluginOnlyAllowlist: true,
        suppressUnavailableCoreToolWarning: params.suppressUnavailableCoreToolWarning,
        suppressUnavailableCoreToolWarningAllowlist:
          params.suppressUnavailableCoreToolWarningAllowlist,
        unavailableCoreToolReason: params.unavailableCoreToolReason,
      },
    ],
  });
  return warnings;
}

describe("tool-policy-pipeline", () => {
  beforeEach(() => {
    toolPolicyAuditDebug.mockClear();
    toolPolicyAuditInfo.mockClear();
  });

  test("preserves plugin-only allowlists instead of silently stripping them", () => {
    const tools = [{ name: "exec" }, { name: "plugin_tool" }];
    const filtered = applyToolPolicyPipeline({
      tools,
      toolMeta: (t) => (t.name === "plugin_tool" ? { pluginId: "foo" } : undefined),
      warn: () => {},
      steps: [
        {
          policy: { allow: ["plugin_tool"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    const names = filtered.map((t) => t.name).toSorted();
    expect(names).toEqual(["plugin_tool"]);
  });

  test("can freeze an allowlist entry against a later plugin-id collision", () => {
    const tools = [{ name: "read" }, { name: "future_tool" }];
    const toolMeta = (tool: DummyTool) =>
      tool.name === "future_tool" ? { pluginId: "read" } : undefined;
    const apply = (frozen: boolean) => {
      const policy = { allow: ["read"] };
      if (frozen) {
        markFrozenClawToolAllowPolicy(policy);
      }
      return applyToolPolicyPipeline({
        tools,
        toolMeta,
        warn: () => {},
        steps: [
          {
            policy,
            label: "agent tools.allow",
            stripPluginOnlyAllowlist: true,
          },
        ],
      }).map((tool) => tool.name);
    };

    expect(apply(false)).toEqual(["future_tool"]);
    expect(apply(true)).toEqual(["read"]);
  });

  test.each([
    { expected: ["exec"], policy: { deny: ["canvas"] } },
    { expected: ["canvas", "show_widget"], policy: { allow: ["canvas"] } },
  ])(
    "applies the Canvas family uniformly even when stale metadata claims show_widget ($policy)",
    ({ expected, policy }) => {
      const tools = [{ name: "exec" }, { name: "show_widget" }, { name: "canvas" }];
      const filtered = applyToolPolicyPipeline({
        tools,
        toolMeta: (tool) => {
          if (tool.name === "show_widget") {
            return { pluginId: "discord" };
          }
          return tool.name === "canvas" ? { pluginId: "canvas" } : undefined;
        },
        warn: () => {},
        steps: [{ policy, label: "tools", stripPluginOnlyAllowlist: true }],
      });

      expect(filtered.map((tool) => tool.name).toSorted()).toEqual(expected);
    },
  );

  test.each([
    { expected: ["progress_card"], policy: { allow: ["update_plan"] } },
    { expected: ["exec"], policy: { deny: ["update_plan"] } },
  ])(
    "maps the shipped update_plan policy name to progress_card ($policy)",
    ({ expected, policy }) => {
      const tools = [{ name: "exec" }, { name: "progress_card" }];
      const filtered = applyToolPolicyPipeline({
        tools,
        toolMeta: () => undefined,
        warn: () => {},
        steps: [{ policy, label: "tools", stripPluginOnlyAllowlist: true }],
      });

      expect(filtered.map((tool) => tool.name).toSorted()).toEqual(expected);
    },
  );

  test("still warns for profile steps when explicit alsoAllow entries are present", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["apply_patch", "browser"],
      label: "tools.profile (coding)",
      suppressUnavailableCoreToolWarningAllowlist: ["apply_patch"],
    });
    expect(warnings).toEqual([
      "tools: tools.profile (coding) allowlist contains unknown entries (browser). These entries are shipped core tools but unavailable in the current runtime/provider/model/config.",
    ]);
  });

  test("classifies pdf as an unavailable gated core tool, not a missing plugin", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["pdf"],
      label: "tools.allow",
    });
    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (pdf). These entries are shipped core tools but unavailable in the current runtime/provider/model/config.",
    ]);
  });

  test("includes the active reason for unavailable core tool warnings", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["apply_patch", "reason_case_unknown"],
      label: "tools.allow",
      unavailableCoreToolReason:
        "memory-triggered compaction runs expose only read and append-only write",
    });
    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (apply_patch, reason_case_unknown). Some entries are shipped core tools but unavailable here: memory-triggered compaction runs expose only read and append-only write; other entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("default profile steps suppress unavailable baseline profile entries", () => {
    const warnings: string[] = [];
    const profilePolicy = resolveToolProfilePolicy("coding");
    applyToolPolicyPipeline({
      tools: [{ name: "exec" }],
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      steps: buildDefaultToolPolicyPipelineSteps({
        profile: "coding",
        profilePolicy,
        profileUnavailableCoreWarningAllowlist: profilePolicy?.allow,
      }),
    });

    expect(warnings).toStrictEqual([]);
  });

  test.each([
    {
      name: "disabled owner",
      plugins: { entries: { "blocked-owner": { enabled: false } } },
      toolDenylist: undefined,
    },
    { name: "denied owner", plugins: { deny: ["blocked-owner"] }, toolDenylist: undefined },
    { name: "tool-denied owner", plugins: {}, toolDenylist: ["blocked-owner"] },
    { name: "denied tool", plugins: {}, toolDenylist: ["blocked_tool"] },
  ])("declared context excludes a $name and keeps eligible tools", ({ plugins, toolDenylist }) => {
    const config = { plugins };
    const workspaceDir = process.cwd();
    const manifestRegistry = makeRegistry([
      {
        id: "Allowed-Owner",
        origin: "bundled",
        channels: [],
        contracts: { tools: ["allowed_tool"] },
      },
      {
        id: "Blocked-Owner",
        origin: "bundled",
        channels: [],
        contracts: { tools: ["blocked_tool"] },
      },
    ]);
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({ config, manifestRegistry, workspaceDir }),
      { config, workspaceDir },
    );
    try {
      expect(buildDeclaredToolAllowlistContext({ config, workspaceDir, toolDenylist })).toEqual({
        pluginIds: ["Allowed-Owner"],
        pluginToolNames: ["allowed_tool"],
      });
    } finally {
      setCurrentPluginMetadataSnapshot(undefined);
    }
  });

  test("warns when disabled MCP server namespace is allowlisted", () => {
    const warnings: string[] = [];
    const declared = buildDeclaredToolAllowlistContext({
      config: {
        mcp: { servers: { disabled: { command: "disabled-mcp", enabled: false } } },
      },
      workspaceDir: process.cwd(),
    });

    applyToolPolicyPipeline({
      tools: [{ name: "exec" }],
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      declaredToolAllowlist: declared,
      steps: [
        {
          policy: { allow: ["disabled__*"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (disabled__*). These entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("warns when denied duplicate-safe MCP server namespace is allowlisted", () => {
    const warnings: string[] = [];
    const declared = buildDeclaredToolAllowlistContext({
      config: {
        mcp: {
          servers: {
            "vigil harbor": { command: "vigil-mcp" },
            "vigil:harbor": { command: "vigil-alt-mcp" },
          },
        },
      },
      workspaceDir: process.cwd(),
      toolDenylist: ["vigil-harbor-2__*"],
    });

    expect(Array.from(declared?.mcpServerNames ?? [])).toEqual(["vigil-harbor"]);

    applyToolPolicyPipeline({
      tools: [{ name: "exec" }],
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      declaredToolAllowlist: declared,
      steps: [
        {
          policy: { allow: ["vigil-harbor__*", "vigil-harbor-2__*"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (vigil-harbor-2__*). These entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("dedupes identical unknown-allowlist warnings across repeated runs", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }];
    const params = {
      tools,
      toolMeta: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["dedupe_case_unknown"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    };

    applyToolPolicyPipeline(params);
    applyToolPolicyPipeline(params);

    expect(warnings).toHaveLength(1);
  });

  test("evicts the oldest warning when the dedupe cache is full", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }];

    for (let i = 0; i < 256; i += 1) {
      applyToolPolicyPipeline({
        tools,
        toolMeta: () => undefined,
        warn: (msg: string) => warnings.push(msg),
        steps: [
          {
            policy: { allow: [`eviction_unknown_${i}`] },
            label: "tools.allow",
            stripPluginOnlyAllowlist: true,
          },
        ],
      });
    }

    warnings.length = 0;

    applyToolPolicyPipeline({
      tools,
      toolMeta: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["eviction_unknown_256"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    applyToolPolicyPipeline({
      tools,
      toolMeta: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["eviction_unknown_0"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (eviction_unknown_256). These entries won't match any tool unless the plugin is enabled.",
      "tools: tools.allow allowlist contains unknown entries (eviction_unknown_0). These entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("reads policy changes at each stage and each new filtering operation", () => {
    const tools = [{ name: "read" }, { name: "write" }, { name: "exec" }];
    const policy = { allow: ["read", "write"], deny: [] as string[] };
    const run = (denied: string) =>
      applyToolPolicyPipeline({
        tools,
        toolMeta: () => undefined,
        warn: () => {},
        steps: [
          { policy: { allow: ["*"] }, label: "first" },
          { policy, label: "second" },
        ],
        onFilter: ({ step }) => {
          if (step.label === "first") {
            policy.deny.splice(0, policy.deny.length, denied);
          }
        },
      });

    const first = run("write");
    expect(first).toEqual([tools[0]]);
    expect(first[0]).toBe(tools[0]);
    const second = run("read");
    expect(second).toEqual([tools[1]]);
    expect(second[0]).toBe(tools[1]);
    expect(tools.map((tool) => tool.name)).toEqual(["read", "write", "exec"]);
  });

  test("reads declared tool changes after each layer's filter callback", () => {
    const tools = [{ name: "read" }];
    const declared = {
      pluginIds: new Set([" First-Owner ", ""]),
      pluginToolNames: ["old-tool", " OLD-TOOL ", ""],
      mcpServerNames: ["Old Server"],
    };
    const events: string[] = [];
    const filtered = applyToolPolicyPipeline({
      tools,
      toolMeta: () => undefined,
      warn: (message) => events.push(message),
      declaredToolAllowlist: declared,
      steps: [
        {
          policy: { allow: ["*", "first-owner", "old-tool", "old-server__*"] },
          label: "declared first",
          stripPluginOnlyAllowlist: true,
        },
        {
          policy: { allow: ["*", "second-owner", "new-tool", "new-server__*", "old-tool"] },
          label: "declared second",
          stripPluginOnlyAllowlist: true,
        },
      ],
      onFilter: ({ step }) => {
        events.push(`filtered: ${step.label}`);
        if (step.label === "declared first") {
          declared.pluginIds.clear();
          declared.pluginIds.add(" Second-Owner ");
          declared.pluginToolNames.splice(0, declared.pluginToolNames.length, " NEW-TOOL ");
          declared.mcpServerNames.splice(0, declared.mcpServerNames.length, "New Server");
        }
      },
    });

    expect(filtered).toEqual(tools);
    expect(filtered[0]).toBe(tools[0]);
    expect(events).toEqual([
      "filtered: declared first",
      "tools: declared second allowlist contains unknown entries (old-tool). These entries won't match any tool unless the plugin is enabled.",
      "filtered: declared second",
    ]);
  });

  test("splits mixed allow and deny policy audit entries by cause", () => {
    const tools = [{ name: "exec" }, { name: "browser" }, { name: "write" }];

    applyToolPolicyPipeline({
      tools,
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["exec"], deny: ["browser"] },
          label: "agents.worker.tools.allow",
        },
      ],
    });

    expect(toolPolicyAuditDebug).toHaveBeenCalledWith(
      "tool policy removed 1 tool(s) via agents.worker.tools.deny: browser; matched browser",
      {
        rule: "agents.worker.tools.deny",
        ruleKind: "deny",
        matchedRules: ["browser"],
        removedToolCount: 1,
        removedTools: ["browser"],
        removedToolsTruncated: false,
      },
    );
    expect(toolPolicyAuditDebug).toHaveBeenCalledWith(
      "tool policy removed 1 tool(s) via agents.worker.tools.allow: write",
      {
        rule: "agents.worker.tools.allow",
        ruleKind: "allow",
        removedToolCount: 1,
        removedTools: ["write"],
        removedToolsTruncated: false,
      },
    );
    expect(toolPolicyAuditInfo).not.toHaveBeenCalled();
  });

  test("does not audit policy steps that leave the tool surface unchanged", () => {
    const tools = [{ name: "exec" }];

    applyToolPolicyPipeline({
      tools,
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["exec"] },
          label: "tools.allow",
        },
      ],
    });

    expect(toolPolicyAuditDebug).not.toHaveBeenCalled();
    expect(toolPolicyAuditInfo).not.toHaveBeenCalled();
  });

  test("sanitizes audit labels and tool names before logging", () => {
    const tools = [{ name: "exec\nbad" }];

    applyToolPolicyPipeline({
      tools,
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["read"] },
          label: "agents.worker\nbad.tools.allow",
        },
      ],
    });

    expect(toolPolicyAuditDebug).toHaveBeenCalledWith(
      "tool policy removed 1 tool(s) via agents.worker\\nbad.tools.allow: exec\\nbad",
      {
        rule: "agents.worker\\nbad.tools.allow",
        ruleKind: "allow",
        removedToolCount: 1,
        removedTools: ["exec\\nbad"],
        removedToolsTruncated: false,
      },
    );
    expect(toolPolicyAuditInfo).not.toHaveBeenCalled();
  });

  test("truncates audit fields without splitting surrogate pairs", () => {
    const tools = [{ name: "exec" }];
    const labelPrefix = "a".repeat(159);

    applyToolPolicyPipeline({
      tools,
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["read"] },
          label: `${labelPrefix}😀suffix`,
        },
      ],
    });

    const rule = `${labelPrefix}...`;
    expect(toolPolicyAuditDebug).toHaveBeenCalledWith(
      `tool policy removed 1 tool(s) via ${rule}: exec`,
      {
        rule,
        ruleKind: "allow",
        removedToolCount: 1,
        removedTools: ["exec"],
        removedToolsTruncated: false,
      },
    );
  });
});
