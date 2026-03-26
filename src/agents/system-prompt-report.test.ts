import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addSubagentRunForTests, resetSubagentRegistryForTests } from "./subagent-registry.js";
import { buildSystemPromptReport } from "./system-prompt-report.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function makeBootstrapFile(overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile {
  return {
    name: "AGENTS.md",
    path: "/tmp/workspace/AGENTS.md",
    content: "alpha",
    missing: false,
    ...overrides,
  };
}

describe("buildSystemPromptReport", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  const makeReport = (params: {
    file: WorkspaceBootstrapFile;
    injectedPath: string;
    injectedContent: string;
    bootstrapMaxChars?: number;
    bootstrapTotalMaxChars?: number;
  }) =>
    buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: params.bootstrapMaxChars ?? 20_000,
      bootstrapTotalMaxChars: params.bootstrapTotalMaxChars,
      systemPrompt: "system",
      bootstrapFiles: [params.file],
      injectedFiles: [{ path: params.injectedPath, content: params.injectedContent }],
      skillsPrompt: "",
      tools: [],
    });

  it("counts injected chars when injected file paths are absolute", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "/tmp/workspace/policies/AGENTS.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("keeps legacy basename matching for injected files", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "AGENTS.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("marks workspace files truncated when injected chars are smaller than raw chars", () => {
    const file = makeBootstrapFile({
      path: "/tmp/workspace/policies/AGENTS.md",
      content: "abcdefghijklmnopqrstuvwxyz",
    });
    const report = makeReport({
      file,
      injectedPath: "/tmp/workspace/policies/AGENTS.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(true);
  });

  it("includes both bootstrap caps in the report payload", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "AGENTS.md",
      injectedContent: "trimmed",
      bootstrapMaxChars: 11_111,
      bootstrapTotalMaxChars: 22_222,
    });

    expect(report.bootstrapMaxChars).toBe(11_111);
    expect(report.bootstrapTotalMaxChars).toBe(22_222);
  });

  it("builds a prompt budget breakdown from system prompt, workspace, skills, and tools", () => {
    const file = makeBootstrapFile({
      path: "/tmp/workspace/policies/AGENTS.md",
      content: "abcdefghij",
    });
    const skillsPrompt = "<skill><name>checks</name><description>x</description></skill>";
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: [
        "Prelude",
        "# Project Context",
        "1234567890",
        "## Silent Replies",
        "Tool names are case-sensitive. Call tools exactly as listed.",
        "read",
        "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
      ].join("\n"),
      bootstrapFiles: [file],
      injectedFiles: [{ path: "/tmp/workspace/policies/AGENTS.md", content: "1234" }],
      skillsPrompt,
      tools: [
        {
          name: "read",
          description: "Read files",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
          },
        } as never,
      ],
    });

    expect(report.promptBudget).toBeDefined();
    const promptBudget = report.promptBudget!;
    expect(promptBudget.workspaceInjectedChars).toBe(4);
    expect(promptBudget.skillsPromptChars).toBe(skillsPrompt.length);
    expect(promptBudget.toolListChars).toBe("read".length);
    expect(promptBudget.toolSchemaChars).toBeGreaterThan(0);
    expect(promptBudget.otherSystemPromptChars).toBeGreaterThanOrEqual(0);
    expect(promptBudget.totalTrackedChars).toBe(
      report.systemPrompt.chars + report.tools.schemaChars,
    );
    expect(report.taskProfile).toEqual({
      id: "coding",
      source: "tool-surface",
      signal: "read",
    });
  });

  it("reports injectedChars=0 when injected file does not match by path or basename", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "/tmp/workspace/policies/OTHER.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe(0);
    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(true);
  });

  it("ignores malformed injected file paths and still matches valid entries", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [file],
      injectedFiles: [
        { path: 123 as unknown as string, content: "bad" },
        { path: "/tmp/workspace/policies/AGENTS.md", content: "trimmed" },
      ],
      skillsPrompt: "",
      tools: [],
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("resolves assistant task profile from default session keys when no stronger signal exists", () => {
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      sessionKey: "agent:default:main",
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: "",
      tools: [],
    });

    expect(report.taskProfile).toEqual({
      id: "assistant",
      source: "session-key",
      signal: "agent:default:main",
    });
  });

  it("reports policy slicing when heartbeat files are excluded from normal runs", () => {
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [
        {
          name: "HEARTBEAT.md",
          path: "/tmp/workspace/HEARTBEAT.md",
          content: "ping",
          missing: false,
        },
      ],
      injectedFiles: [
        {
          path: "/tmp/workspace/HEARTBEAT.md",
          content: "",
          policySlicing: {
            applied: true,
            mode: "file",
            originalChars: 4,
            slicedChars: 4,
            retainedChars: 0,
            reasons: ["heartbeat-only file excluded outside heartbeat runs"],
          },
        },
      ],
      skillsPrompt: "",
      tools: [],
    });

    expect(report.policySlicing).toEqual({
      totalSlicedChars: 4,
      slicedFileCount: 1,
      entries: [
        {
          name: "HEARTBEAT.md",
          path: "/tmp/workspace/HEARTBEAT.md",
          slicedChars: 4,
          reasons: ["heartbeat-only file excluded outside heartbeat runs"],
        },
      ],
    });
    expect(report.injectedWorkspaceFiles[0]?.sliced).toBe(true);
    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(false);
  });

  it("discovers workspace policy files beyond fixed bootstrap names", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-policy-report-"));
    try {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "agents", "utf-8");
      await fs.writeFile(path.join(tempDir, "standing-orders.md"), "orders", "utf-8");
      await fs.mkdir(path.join(tempDir, "docs"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "docs", "workflow.md"), "flow", "utf-8");

      const report = buildSystemPromptReport({
        source: "run",
        generatedAt: 0,
        workspaceDir: tempDir,
        bootstrapMaxChars: 20_000,
        systemPrompt: "system",
        bootstrapFiles: [
          {
            name: "AGENTS.md",
            path: path.join(tempDir, "AGENTS.md"),
            content: "agents",
            missing: false,
          },
        ],
        injectedFiles: [{ path: path.join(tempDir, "AGENTS.md"), content: "agents" }],
        skillsPrompt: "",
        tools: [],
      });

      expect(report.workspacePolicyDiscovery?.totalDiscovered).toBe(3);
      expect(report.workspacePolicyDiscovery?.injectedCount).toBe(1);
      expect(report.workspacePolicyDiscovery?.candidateCount).toBe(2);
      expect(report.workspacePolicyDiscovery?.mergeOrder).toEqual(["AGENTS.md"]);
      expect(report.workspacePolicyDiscovery?.conflictCount).toBe(0);
      expect(report.workspacePolicyDiscovery?.entries.map((entry) => entry.name)).toEqual([
        "AGENTS.md",
        "workflow.md",
        "standing-orders.md",
      ]);
      expect(report.workspacePolicyDiscovery?.entries[0]).toMatchObject({
        name: "AGENTS.md",
        policyRole: "global-guidance",
        mergePriority: 100,
        mergeTier: "primary",
        source: "workspace-root",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("includes dynamic tool pruning details when provided by runtime", () => {
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: "",
      tools: [],
      toolPruning: {
        prunedCount: 2,
        prunedSummaryChars: 25,
        prunedSchemaChars: 120,
        entries: [
          {
            name: "browser",
            reason: "no explicit web or browser signal in prompt",
            summaryChars: 10,
            schemaChars: 80,
          },
          {
            name: "message",
            reason: "no explicit messaging or reply signal in prompt",
            summaryChars: 15,
            schemaChars: 40,
          },
        ],
      },
    });

    expect(report.toolPruning).toEqual({
      prunedCount: 2,
      prunedSummaryChars: 25,
      prunedSchemaChars: 120,
      entries: [
        {
          name: "browser",
          reason: "no explicit web or browser signal in prompt",
          summaryChars: 10,
          schemaChars: 80,
        },
        {
          name: "message",
          reason: "no explicit messaging or reply signal in prompt",
          summaryChars: 15,
          schemaChars: 40,
        },
      ],
    });
  });

  it("includes dynamic skill pruning details when provided by runtime", () => {
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: "",
      tools: [],
      skillPruning: {
        prunedCount: 2,
        prunedBlockChars: 240,
        entries: [
          {
            name: "healthcheck",
            reason: "no runtime ops signal in prompt",
            blockChars: 120,
          },
          {
            name: "skill-creator",
            reason: "no skill-authoring signal in prompt",
            blockChars: 120,
          },
        ],
      },
    });

    expect(report.skillPruning).toEqual({
      prunedCount: 2,
      prunedBlockChars: 240,
      entries: [
        {
          name: "healthcheck",
          reason: "no runtime ops signal in prompt",
          blockChars: 120,
        },
        {
          name: "skill-creator",
          reason: "no skill-authoring signal in prompt",
          blockChars: 120,
        },
      ],
    });
  });

  it("includes delegation profile details for subagent sessions", () => {
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      sessionKey: "agent:main:subagent:worker-1",
      spawnedBy: "agent:main:main",
      workspaceDir: "/tmp/workspace",
      config: {
        agents: {
          defaults: {
            subagents: {
              maxSpawnDepth: 2,
            },
          },
        },
      },
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: "",
      tools: [
        { name: "sessions_spawn" },
        { name: "subagents" },
        { name: "sessions_list" },
      ] as never,
    });

    expect(report.delegationProfile).toMatchObject({
      role: "orchestrator",
      depth: 1,
      workspaceSource: "inherited",
      parentSessionKey: "agent:main:main",
    });
    expect(report.delegationProfile?.delegationToolsAllowed).toEqual([
      "sessions_spawn",
      "subagents",
      "sessions_list",
    ]);
  });

  it("includes role-preset defaults in delegation reporting when the run declares planner semantics", () => {
    addSubagentRunForTests({
      runId: "run-planner",
      childSessionKey: "agent:main:subagent:planner-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "Plan the feature slice",
      label: "planner-pass",
      rolePreset: "planner",
      buildRunId: "run-42",
      buildRunDir: "/tmp/workspace/.openclaw/build-runs/run-42",
      cleanup: "keep",
      createdAt: Date.now(),
    });

    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      sessionKey: "agent:main:subagent:planner-1",
      spawnedBy: "agent:main:main",
      workspaceDir: "/tmp/workspace",
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: "",
      tools: [{ name: "read" }, { name: "sessions_list" }] as never,
    });

    expect(report.delegationProfile).toMatchObject({
      rolePreset: "planner",
      promptMode: "plan",
      toolBias: "read-heavy",
      verificationPosture: "acceptance-first",
      artifactWriteScope: "planner-artifacts",
      buildRunId: "run-42",
      buildRunDir: "/tmp/workspace/.openclaw/build-runs/run-42",
    });
  });
});
