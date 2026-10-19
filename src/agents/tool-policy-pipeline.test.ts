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

function expectAudit(
  rule: string,
  ruleKind: "allow" | "deny",
  tool: string,
  matchedRules?: string[],
) {
  expect(toolPolicyAuditDebug).toHaveBeenCalledWith(
    `tool policy removed 1 tool(s) via ${rule}: ${tool}${matchedRules ? `; matched ${matchedRules.join(", ")}` : ""}`,
    {
      rule,
      ruleKind,
      removedToolCount: 1,
      removedTools: [tool],
      removedToolsTruncated: false,
      ...(matchedRules ? { matchedRules } : {}),
    },
  );
}
type DummyTool = { name: string };
type PipelineParams = Parameters<typeof applyToolPolicyPipeline<DummyTool>>[0];
function runPipeline(params: Pick<PipelineParams, "steps"> & Partial<PipelineParams>) {
  return applyToolPolicyPipeline({
    tools: [{ name: "exec" }],
    toolMeta: () => undefined,
    warn: () => {},
    ...params,
  });
}
function runPolicy(
  names: string[],
  policy: PipelineParams["steps"][number]["policy"],
  label = "tools",
  toolMeta: PipelineParams["toolMeta"] = () => undefined,
  stripPluginOnlyAllowlist = false,
) {
  return runPipeline({
    tools: names.map((name) => ({ name })),
    toolMeta,
    steps: [{ policy, label, stripPluginOnlyAllowlist }],
  });
}
function filterNames(
  names: string[],
  policy: PipelineParams["steps"][number]["policy"],
  toolMeta: PipelineParams["toolMeta"] = () => undefined,
  label = "tools",
) {
  return runPolicy(names, policy, label, toolMeta, true)
    .map((tool) => tool.name)
    .toSorted();
}
function runAllowlistWarningStep({
  allow,
  label = "tools.allow",
  warnings = [],
  declaredToolAllowlist,
  ...options
}: {
  allow: string[];
  label?: string;
  warnings?: string[];
  declaredToolAllowlist?: PipelineParams["declaredToolAllowlist"];
  suppressUnavailableCoreToolWarning?: boolean;
  suppressUnavailableCoreToolWarningAllowlist?: string[];
  unavailableCoreToolReason?: string;
}) {
  runPipeline({
    warn: (msg) => warnings.push(msg),
    declaredToolAllowlist,
    steps: [{ policy: { allow }, label, stripPluginOnlyAllowlist: true, ...options }],
  });
  return warnings;
}

describe("tool-policy-pipeline", () => {
  beforeEach(() => {
    toolPolicyAuditDebug.mockClear();
    toolPolicyAuditInfo.mockClear();
  });

  test("preserves plugin-only allowlists instead of silently stripping them", () => {
    expect(
      filterNames(
        ["exec", "plugin_tool"],
        { allow: ["plugin_tool"] },
        (t) => (t.name === "plugin_tool" ? { pluginId: "foo" } : undefined),
        "tools.allow",
      ),
    ).toEqual(["plugin_tool"]);
  });

  test("can freeze an allowlist entry against a later plugin-id collision", () => {
    const apply = (frozen: boolean) => {
      const policy = { allow: ["read"] };
      if (frozen) {
        markFrozenClawToolAllowPolicy(policy);
      }
      return filterNames(
        ["read", "future_tool"],
        policy,
        (tool) => (tool.name === "future_tool" ? { pluginId: "read" } : undefined),
        "agent tools.allow",
      );
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
      expect(
        filterNames(["exec", "show_widget", "canvas"], policy, (tool) =>
          tool.name === "show_widget"
            ? { pluginId: "discord" }
            : tool.name === "canvas"
              ? { pluginId: "canvas" }
              : undefined,
        ),
      ).toEqual(expected);
    },
  );

  test.each([
    { expected: ["progress_card"], policy: { allow: ["update_plan"] } },
    { expected: ["exec"], policy: { deny: ["update_plan"] } },
  ])(
    "maps the shipped update_plan policy name to progress_card ($policy)",
    ({ expected, policy }) => {
      expect(filterNames(["exec", "progress_card"], policy)).toEqual(expected);
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
    runPipeline({
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
    const manifestRegistry = makeRegistry(
      ["Allowed", "Blocked"].map((owner) => ({
        id: `${owner}-Owner`,
        origin: "bundled" as const,
        channels: [],
        contracts: { tools: [`${owner.toLowerCase()}_tool`] },
      })),
    );
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

    runAllowlistWarningStep({ allow: ["disabled__*"], warnings, declaredToolAllowlist: declared });

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

    runAllowlistWarningStep({
      allow: ["vigil-harbor__*", "vigil-harbor-2__*"],
      warnings,
      declaredToolAllowlist: declared,
    });

    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (vigil-harbor-2__*). These entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("dedupes identical unknown-allowlist warnings across repeated runs", () => {
    const warnings: string[] = [];
    const params = { allow: ["dedupe_case_unknown"], warnings };
    runAllowlistWarningStep(params);
    runAllowlistWarningStep(params);
    expect(warnings).toHaveLength(1);
  });

  test("evicts the oldest warning when the dedupe cache is full", () => {
    const warnings: string[] = [];
    const warn = (index: number) =>
      runAllowlistWarningStep({ allow: [`eviction_unknown_${index}`], warnings });
    for (let i = 0; i < 256; i++) {
      warn(i);
    }
    warnings.length = 0;
    warn(256);
    warn(0);
    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (eviction_unknown_256). These entries won't match any tool unless the plugin is enabled.",
      "tools: tools.allow allowlist contains unknown entries (eviction_unknown_0). These entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("reads policy changes at each stage and each new filtering operation", () => {
    const tools = [{ name: "read" }, { name: "write" }, { name: "exec" }];
    const policy = { allow: ["read", "write"], deny: [] as string[] };
    const run = (denied: string) =>
      runPipeline({
        tools,
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
    const filtered = runPipeline({
      tools,
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
    runPolicy(
      ["exec", "browser", "write"],
      { allow: ["exec"], deny: ["browser"] },
      "agents.worker.tools.allow",
    );

    expectAudit("agents.worker.tools.deny", "deny", "browser", ["browser"]);
    expectAudit("agents.worker.tools.allow", "allow", "write");
    expect(toolPolicyAuditInfo).not.toHaveBeenCalled();
  });

  test("sanitizes audit labels and tool names before logging", () => {
    runPolicy(["exec\nbad"], { allow: ["read"] }, "agents.worker\nbad.tools.allow");

    expectAudit("agents.worker\\nbad.tools.allow", "allow", "exec\\nbad");
    expect(toolPolicyAuditInfo).not.toHaveBeenCalled();
  });

  test("truncates audit fields without splitting surrogate pairs", () => {
    const labelPrefix = "a".repeat(159);
    runPolicy(["exec"], { allow: ["read"] }, `${labelPrefix}😀suffix`);

    const rule = `${labelPrefix}...`;
    expectAudit(rule, "allow", "exec");
  });
});
