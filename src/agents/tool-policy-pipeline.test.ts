import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
  resetToolPolicyWarningCacheForTest,
} from "./tool-policy-pipeline.js";
import { resolveToolProfilePolicy } from "./tool-policy.js";

const { toolPolicyAuditInfo } = vi.hoisted(() => ({
  toolPolicyAuditInfo: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: toolPolicyAuditInfo,
    warn: vi.fn(),
  }),
}));

type DummyTool = { name: string };

function runAllowlistWarningStep(params: {
  allow: string[];
  label: string;
  suppressUnavailableCoreToolWarning?: boolean;
  suppressUnavailableCoreToolWarningAllowlist?: string[];
}) {
  const warnings: string[] = [];
  const tools = [{ name: "exec" }] as unknown as DummyTool[];
  applyToolPolicyPipeline({
    tools: tools as any,
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
      },
    ],
  });
  return warnings;
}

describe("tool-policy-pipeline", () => {
  beforeEach(() => {
    resetToolPolicyWarningCacheForTest();
    toolPolicyAuditInfo.mockClear();
  });

  test("preserves plugin-only allowlists instead of silently stripping them", () => {
    const tools = [{ name: "exec" }, { name: "plugin_tool" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      tools: tools as any,
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
    expect(names).toEqual(["plugin_tool"]);
  });

  test("warns about unknown allowlist entries", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];
    applyToolPolicyPipeline({
      tools: tools as any,
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

  test("suppresses built-in profile warnings for unavailable gated core tools", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["apply_patch"],
      label: "tools.profile (coding)",
      suppressUnavailableCoreToolWarningAllowlist: ["apply_patch"],
    });
    expect(warnings).toEqual([]);
  });

  test("still warns for profile steps when explicit alsoAllow entries are present", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["apply_patch", "browser"],
      label: "tools.profile (coding)",
      suppressUnavailableCoreToolWarningAllowlist: ["apply_patch"],
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("unknown entries (browser)");
    expect(warnings[0]).not.toContain("apply_patch");
    expect(warnings[0]).toContain(
      "shipped core tools but unavailable in the current runtime/provider/model/config",
    );
  });

  test("still warns for explicit allowlists that mention unavailable gated core tools", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["apply_patch"],
      label: "tools.allow",
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("unknown entries (apply_patch)");
    expect(warnings[0]).toContain(
      "shipped core tools but unavailable in the current runtime/provider/model/config",
    );
    expect(warnings[0]).not.toContain("Allowlist contains only plugin entries");
    expect(warnings[0]).not.toContain("unless the plugin is enabled");
  });

  test("default profile steps suppress unavailable baseline profile entries", () => {
    const warnings: string[] = [];
    const profilePolicy = resolveToolProfilePolicy("coding");
    applyToolPolicyPipeline({
      tools: [{ name: "exec" }] as any,
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      steps: buildDefaultToolPolicyPipelineSteps({
        profile: "coding",
        profilePolicy,
        profileUnavailableCoreWarningAllowlist: profilePolicy?.allow,
      }),
    });

    expect(warnings).toEqual([]);
  });

  test("dedupes identical unknown-allowlist warnings across repeated runs", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];
    const params = {
      tools: tools as any,
      toolMeta: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["wat"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    };

    applyToolPolicyPipeline(params);
    applyToolPolicyPipeline(params);

    expect(warnings).toHaveLength(1);
  });

  test("bounds the warning dedupe cache so new warnings still surface", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];

    for (let i = 0; i < 257; i += 1) {
      applyToolPolicyPipeline({
        tools: tools as any,
        toolMeta: () => undefined,
        warn: (msg: string) => warnings.push(msg),
        steps: [
          {
            policy: { allow: [`unknown_${i}`] },
            label: "tools.profile (coding)",
            stripPluginOnlyAllowlist: true,
          },
        ],
      });
    }

    applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["unknown_0"] },
          label: "tools.profile (coding)",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toHaveLength(258);
  });

  test("evicts the oldest warning when the dedupe cache is full", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];

    for (let i = 0; i < 256; i += 1) {
      applyToolPolicyPipeline({
        tools: tools as any,
        toolMeta: () => undefined,
        warn: (msg: string) => warnings.push(msg),
        steps: [
          {
            policy: { allow: [`unknown_${i}`] },
            label: "tools.allow",
            stripPluginOnlyAllowlist: true,
          },
        ],
      });
    }

    warnings.length = 0;

    applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["unknown_256"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      steps: [
        { policy: { allow: ["unknown_0"] }, label: "tools.allow", stripPluginOnlyAllowlist: true },
      ],
    });

    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("unknown_0");
  });

  test("applies allowlist filtering when core tools are explicitly listed", () => {
    const tools = [{ name: "exec" }, { name: "process" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      tools: tools as any,
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

  test("applies deny filtering after allow filtering", () => {
    const tools = [{ name: "exec" }, { name: "process" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["exec", "process"], deny: ["process"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    expect(filtered.map((t) => (t as unknown as DummyTool).name)).toEqual(["exec"]);
  });

  test("audits the policy rule that removes tools without changing sender grouping semantics", () => {
    const tools = [
      { name: "exec" },
      { name: "browser" },
      { name: "write" },
      { name: "read" },
    ] as unknown as DummyTool[];

    const filtered = applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["exec", "read"] },
          label: "group tools.allow",
        },
      ],
    });

    expect(filtered.map((t) => (t as unknown as DummyTool).name)).toEqual(["exec", "read"]);
    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
      "tool policy removed 2 tool(s) via group tools.allow: browser, write",
      {
        rule: "group tools.allow",
        ruleKind: "allow",
        removedToolCount: 2,
        removedTools: ["browser", "write"],
        removedToolsTruncated: false,
      },
    );
  });

  test("audits deny removals with the deny config key and matched rule", () => {
    const tools = [{ name: "exec" }, { name: "browser" }] as unknown as DummyTool[];

    applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { deny: ["browser"] },
          label: "tools.allow",
        },
      ],
    });

    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
      "tool policy removed 1 tool(s) via tools.deny: browser; matched browser",
      {
        rule: "tools.deny",
        ruleKind: "deny",
        matchedRules: ["browser"],
        removedToolCount: 1,
        removedTools: ["browser"],
        removedToolsTruncated: false,
      },
    );
  });

  test("splits mixed allow and deny policy audit entries by cause", () => {
    const tools = [
      { name: "exec" },
      { name: "browser" },
      { name: "write" },
    ] as unknown as DummyTool[];

    applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["exec"], deny: ["browser"] },
          label: "agents.worker.tools.allow",
        },
      ],
    });

    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
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
    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
      "tool policy removed 1 tool(s) via agents.worker.tools.allow: write",
      {
        rule: "agents.worker.tools.allow",
        ruleKind: "allow",
        removedToolCount: 1,
        removedTools: ["write"],
        removedToolsTruncated: false,
      },
    );
  });

  test("does not audit policy steps that leave the tool surface unchanged", () => {
    const tools = [{ name: "exec" }] as unknown as DummyTool[];

    applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["exec"] },
          label: "tools.allow",
        },
      ],
    });

    expect(toolPolicyAuditInfo).not.toHaveBeenCalled();
  });

  test("sanitizes audit labels and tool names before logging", () => {
    const tools = [{ name: "exec\nbad" }] as unknown as DummyTool[];

    applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["read"] },
          label: "agents.worker\nbad.tools.allow",
        },
      ],
    });

    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
      "tool policy removed 1 tool(s) via agents.worker\\nbad.tools.allow: exec\\nbad",
      {
        rule: "agents.worker\\nbad.tools.allow",
        ruleKind: "allow",
        removedToolCount: 1,
        removedTools: ["exec\\nbad"],
        removedToolsTruncated: false,
      },
    );
  });
});
