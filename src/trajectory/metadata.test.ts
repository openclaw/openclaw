import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import type { SkillSnapshot } from "../skills/types.js";

type ResolvedSkillEntry = NonNullable<SkillSnapshot["resolvedSkills"]>[number];

const loadPluginMetadataSnapshot = vi.hoisted(() =>
  vi.fn(() => ({ plugins: [], manifestRegistry: { plugins: [] } })),
);

vi.mock("../infra/git-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/git-commit.js")>()),
  resolveCommitHash: () => "abcdef0",
}));

// mock-isolation: Export metadata uses a fixed plugin snapshot, independent of installed plugins.
vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot,
}));

import { buildTrajectoryArtifacts, buildTrajectoryRunMetadata } from "./metadata.js";

function metadata(options: Partial<Parameters<typeof buildTrajectoryRunMetadata>[0]> = {}) {
  return buildTrajectoryRunMetadata({
    workspaceDir: "/tmp/workspace",
    timeoutMs: 30_000,
    ...options,
  });
}

function skill(name: string, description: string): ResolvedSkillEntry {
  const baseDir = `/tmp/workspace/skills/${name}`;
  const filePath = `${baseDir}/SKILL.md`;
  return createCanonicalFixtureSkill({
    name,
    description,
    filePath,
    baseDir,
    source: "workspace",
  });
}

const partialSkill = {
  source: "workspace",
  disableModelInvocation: false,
} as unknown as ResolvedSkillEntry;

afterEach(() => {
  resetPluginRuntimeStateForTest();
  loadPluginMetadataSnapshot.mockClear();
});

describe("trajectory metadata", () => {
  it("uses prepared plugin metadata without rescanning manifests", () => {
    const captured = metadata({
      pluginMetadataSnapshot: { plugins: [{ id: "prepared-plugin" }] } as never,
    });

    expect(captured.plugins).toMatchObject({
      source: "manifest-registry",
      entries: [{ id: "prepared-plugin" }],
    });
    expect(loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("redacts harness argv and local paths with the support redaction rules", () => {
    const originalArgv = process.argv;
    process.argv = [
      "node",
      "/Users/tester/project/openclaw.js",
      "--api-key",
      "super-secret",
      "--config=/Users/tester/.openclaw/openclaw.json",
    ];
    try {
      const captured = metadata({
        env: {
          HOME: "/Users/tester",
          OPENCLAW_STATE_DIR: "/Users/tester/.openclaw",
        },
        workspaceDir: "/Users/tester/project",
        sessionFile: "/Users/tester/project/session.jsonl",
      });

      expect(captured.harness).toMatchObject({
        invocation: [
          "node",
          "~/project/openclaw.js",
          "--api-key",
          "<redacted>",
          "--config=$OPENCLAW_STATE_DIR/openclaw.json",
        ],
        entrypoint: "~/project/openclaw.js",
        workspaceDir: "~/project",
        sessionFile: "~/project/session.jsonl",
      });
    } finally {
      process.argv = originalArgv;
    }
  });

  it("captures redacted config plus active plugin and skill inventory", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "demo-plugin",
        imported: true,
        toolNames: ["demo_tool"],
      }),
    );
    setActivePluginRegistry(registry, "trajectory-metadata-test");

    const captured = metadata({
      config: { providers: { openai: { apiKey: "super-secret" } } } as never,
      sessionFile: "/tmp/workspace/session.jsonl",
      sessionKey: "agent:main:test",
      agentId: "main",
      trigger: "user",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "responses",
      reasoningLevel: "high",
      skillsSnapshot: {
        prompt: "skill prompt",
        version: 1,
        skills: [{ name: "weather" }],
        resolvedSkills: [skill("weather", "Check weather")],
      },
      userPromptPrefixText: "prefix",
    });

    expect(captured).toMatchObject({
      config: { redacted: { providers: { openai: { apiKey: REDACTED_SENTINEL } } } },
      plugins: { source: "active-registry", entries: [{ id: "demo-plugin" }] },
      skills: { entries: [{ id: "weather", filePath: "/tmp/workspace/skills/weather/SKILL.md" }] },
    });
  });

  it.each([
    {
      name: "retains valid resolved skills beside partial entries",
      resolved: [skill("alpha", "valid entry"), partialSkill],
      fallback: [],
      expected: "alpha",
    },
    {
      name: "falls back when every resolved skill is partial",
      resolved: [partialSkill],
      fallback: [{ name: "fallback-skill" }],
      expected: "fallback-skill",
    },
  ])("$name", ({ resolved, fallback, expected }) => {
    const captured = metadata({
      sessionFile: "/tmp/workspace/session.jsonl",
      skillsSnapshot: {
        prompt: "skill prompt",
        version: 1,
        skills: fallback,
        resolvedSkills: resolved,
      },
    });

    expect(captured.skills).toMatchObject({ entries: [{ name: expected }] });
  });

  it("captures final artifact summaries for export sidecars", () => {
    const artifacts = buildTrajectoryArtifacts({
      status: "success",
      aborted: false,
      externalAbort: false,
      timedOut: false,
      idleTimedOut: false,
      timedOutDuringCompaction: false,
      timedOutDuringToolExecution: false,
      timedOutByRunBudget: false,
      compactionCount: 1,
      assistantTexts: ["done"],
      finalPromptText: "run tests",
      itemLifecycle: {
        startedCount: 2,
        completedCount: 2,
        activeCount: 0,
      },
      toolMetas: [{ toolName: "bash", meta: "npm test" }],
      didSendViaMessagingTool: false,
      successfulCronAdds: 0,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
    });

    expect(artifacts).toMatchObject({
      finalStatus: "success",
      assistantTexts: ["done"],
      itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
    });
  });
});
