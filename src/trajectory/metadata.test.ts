import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import * as supportRedaction from "../logging/diagnostic-support-redaction.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
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
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
  resetPluginRuntimeStateForTest();
  loadPluginMetadataSnapshot.mockClear();
});

describe("trajectory metadata", () => {
  it("redacts shared immutable catalog entries once for interleaved snapshot selections and homes", () => {
    const alpha = skill("alpha", "Alpha");
    const beta = skill("beta", "Beta");
    for (const entry of [alpha, beta]) {
      Object.freeze(entry.sourceInfo);
      Object.freeze(entry);
    }
    const sanitize = vi.spyOn(supportRedaction, "sanitizeSupportSnapshotValue");
    const captures = [];
    for (let round = 0; round < 3; round++) {
      for (const home of ["/tmp/workspace", "/elsewhere"]) {
        captures.push(
          metadata({
            env: { HOME: home, OPENCLAW_STATE_DIR: `${home}/.openclaw` },
            skillsSnapshot: {
              prompt: "",
              skills: [],
              version: round,
              resolvedSkills: round === 1 ? [beta] : [beta, alpha],
            },
          }).skills,
        );
      }
    }
    expect(captures[0]).toMatchObject({
      snapshotVersion: 0,
      entries: [
        { name: "alpha", filePath: "~/skills/alpha/SKILL.md" },
        { name: "beta", filePath: "~/skills/beta/SKILL.md" },
      ],
    });
    expect(captures[3]).toMatchObject({
      snapshotVersion: 1,
      entries: [{ name: "beta", filePath: "/tmp/workspace/skills/beta/SKILL.md" }],
    });
    expect(captures[4]).toMatchObject({ snapshotVersion: 2 });
    for (const entry of [alpha, beta]) {
      expect(sanitize.mock.calls.filter(([value]) => value === entry.sourceInfo)).toHaveLength(2);
    }
  });

  it("refreshes immutable skill redaction when a new exact secret is registered", () => {
    const entry = skill("guide", "Guide");
    entry.sourceInfo.source = "orchid-canary-material";
    Object.freeze(entry.sourceInfo);
    Object.freeze(entry);
    const options = { skillsSnapshot: { prompt: "", skills: [], resolvedSkills: [entry] } };
    const before = metadata(options);
    registerSecretValueForRedaction("orchid-canary-material");
    const after = metadata(options);
    expect(before.skills).toMatchObject({
      entries: [{ sourceInfo: { source: "orchid-canary-material" } }],
    });
    expect(after.skills).toMatchObject({ entries: [{ sourceInfo: { source: "orchid…rial" } }] });
    resetSecretRedactionRegistryForTest();
    expect(metadata(options).skills).toMatchObject({
      entries: [{ sourceInfo: { source: "orchid-canary-material" } }],
    });
  });

  it.each(["secret", "home"])("rechecks %s changes made by an earlier skill accessor", (change) => {
    const env = { HOME: "/tmp/workspace", OPENCLAW_STATE_DIR: "/synthetic/state" };
    const cached = skill("beta", "Beta");
    cached.sourceInfo.source = "orchid-canary-material";
    Object.freeze(cached.sourceInfo);
    Object.freeze(cached);
    const capture = (resolvedSkills: ResolvedSkillEntry[]) =>
      metadata({ env, skillsSnapshot: { prompt: "", skills: [], resolvedSkills } }).skills;
    capture([cached]);
    const earlier = skill("alpha", "Alpha");
    Object.defineProperty(earlier.sourceInfo, "source", {
      get() {
        if (change === "secret") {
          registerSecretValueForRedaction("orchid-canary-material");
        } else {
          env.HOME = "/another/home";
        }
        return "workspace";
      },
    });
    expect(capture([earlier, cached])).toMatchObject({
      entries: [
        { name: "alpha" },
        {
          name: "beta",
          filePath:
            change === "home" ? "/tmp/workspace/skills/beta/SKILL.md" : "~/skills/beta/SKILL.md",
          sourceInfo: {
            source: change === "secret" ? "orchid…rial" : "orchid-canary-material",
          },
        },
      ],
    });
    if (change === "home") {
      env.HOME = "/tmp/workspace";
      expect(capture([cached])).toMatchObject({
        entries: [{ name: "beta", filePath: "~/skills/beta/SKILL.md" }],
      });
    }
  });

  it("preserves per-capture private key numbering and mutable nested source metadata", () => {
    const nested = { note: "first" };
    const first = skill("alpha", "Alpha");
    const second = skill("beta", "Beta");
    Object.assign(first.sourceInfo, { "a@example.test": "one", nested });
    Object.assign(second.sourceInfo, { "b@example.test": "two" });
    for (const entry of [first, second]) {
      Object.freeze(entry.sourceInfo);
      Object.freeze(entry);
    }
    const capture = (resolvedSkills: ResolvedSkillEntry[]) =>
      metadata({ skillsSnapshot: { prompt: "", skills: [], resolvedSkills } }).skills;
    expect(capture([first, second])).toMatchObject({
      entries: [
        { sourceInfo: { "<identifier#1>": "one", nested: { note: "first" } } },
        { sourceInfo: { "<identifier#2>": "two" } },
      ],
    });
    nested.note = "changed";
    expect(capture([second, first])).toMatchObject({
      entries: [
        { sourceInfo: { "<identifier#2>": "one", nested: { note: "changed" } } },
        { sourceInfo: { "<identifier#1>": "two" } },
      ],
    });
  });

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
