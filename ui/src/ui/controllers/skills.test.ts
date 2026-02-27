import { describe, expect, it, vi } from "vitest";
import {
  loadSkillVerdict,
  loadSkills,
  toggleSkillVerdictPanel,
  type SkillsState,
} from "./skills.ts";

function createState(): { state: SkillsState; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  const state: SkillsState = {
    client: {
      request,
    } as unknown as SkillsState["client"],
    connected: true,
    skillsLoading: false,
    skillsReport: null,
    skillsError: null,
    skillsBusyKey: null,
    skillEdits: {},
    skillMessages: {},
    skillVerdicts: {},
    skillVerdictErrors: {},
    skillVerdictExpanded: {},
    skillVerdictLoadingKey: null,
  };
  return { state, request };
}

describe("skills controller verdict behavior", () => {
  it("loads and stores skill verdict details", async () => {
    const { state, request } = createState();
    request.mockResolvedValueOnce({
      skillKey: "peekaboo",
      skillName: "peekaboo",
      verdict: "review",
      confidence: 0.81,
      generatedAtMs: 1,
      summary: {
        scannedFiles: 2,
        critical: 0,
        warn: 1,
        info: 0,
        ruleIds: ["suspicious-network"],
      },
      antiAbuse: {
        maxFiles: 500,
        maxFileBytes: 1024 * 1024,
        cappedAtMaxFiles: false,
      },
      remediationHints: ["Restrict outbound endpoints."],
      findings: [],
    });

    await loadSkillVerdict(state, "peekaboo");

    expect(request).toHaveBeenCalledWith("skills.verdict", { skillKey: "peekaboo" });
    expect(state.skillVerdicts.peekaboo?.verdict).toBe("review");
    expect(state.skillVerdictErrors.peekaboo).toBeUndefined();
    expect(state.skillVerdictLoadingKey).toBeNull();
  });

  it("records verdict loading errors", async () => {
    const { state, request } = createState();
    request.mockRejectedValueOnce(new Error("scan failed"));

    await loadSkillVerdict(state, "peekaboo");

    expect(state.skillVerdicts.peekaboo).toBeUndefined();
    expect(state.skillVerdictErrors.peekaboo).toContain("scan failed");
    expect(state.skillVerdictLoadingKey).toBeNull();
  });

  it("expands verdict panel and triggers lazy verdict load", async () => {
    const { state, request } = createState();
    request.mockResolvedValueOnce({
      skillKey: "peekaboo",
      skillName: "peekaboo",
      verdict: "pass",
      confidence: 0.69,
      generatedAtMs: 1,
      summary: {
        scannedFiles: 1,
        critical: 0,
        warn: 0,
        info: 0,
        ruleIds: [],
      },
      antiAbuse: {
        maxFiles: 500,
        maxFileBytes: 1024 * 1024,
        cappedAtMaxFiles: false,
      },
      remediationHints: ["No suspicious patterns were flagged."],
      findings: [],
    });

    toggleSkillVerdictPanel(state, "peekaboo");
    await Promise.resolve();
    await Promise.resolve();

    expect(state.skillVerdictExpanded.peekaboo).toBe(true);
    expect(request).toHaveBeenCalledWith("skills.verdict", { skillKey: "peekaboo" });

    toggleSkillVerdictPanel(state, "peekaboo");
    expect(state.skillVerdictExpanded.peekaboo).toBe(false);
  });

  it("prunes verdict state when skills list changes", async () => {
    const { state, request } = createState();
    state.skillVerdicts = {
      stale: {
        skillKey: "stale",
        skillName: "stale",
        verdict: "review",
        confidence: 0.8,
        generatedAtMs: 1,
        summary: { scannedFiles: 1, critical: 0, warn: 1, info: 0, ruleIds: ["x"] },
        antiAbuse: { maxFiles: 500, maxFileBytes: 1024 * 1024, cappedAtMaxFiles: false },
        remediationHints: ["x"],
        findings: [],
      },
    };
    state.skillVerdictErrors = { stale: "stale error" };
    state.skillVerdictExpanded = { stale: true };
    request.mockResolvedValueOnce({
      workspaceDir: "/tmp/work",
      managedSkillsDir: "/tmp/work/managed",
      skills: [
        {
          name: "peekaboo",
          description: "peek",
          source: "openclaw-workspace",
          filePath: "/tmp/work/skills/peekaboo/SKILL.md",
          baseDir: "/tmp/work/skills/peekaboo",
          skillKey: "peekaboo",
          always: false,
          disabled: false,
          blockedByAllowlist: false,
          eligible: true,
          requirements: { bins: [], env: [], config: [], os: [] },
          missing: { bins: [], env: [], config: [], os: [] },
          configChecks: [],
          install: [],
        },
      ],
    });

    await loadSkills(state);

    expect(state.skillVerdicts.stale).toBeUndefined();
    expect(state.skillVerdictErrors.stale).toBeUndefined();
    expect(state.skillVerdictExpanded.stale).toBeUndefined();
  });
});
