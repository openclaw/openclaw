import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  appendChiefSpecialistConsultationPrompt,
  buildChiefSpecialistConsultationSystemPrompt,
  CHIEF_SPECIALIST_CONSULTATION_MARKER,
  hasChiefSpecialistConsultationPrompt,
  maybeBuildChiefSpecialistConsultationPrompt,
  resolveChiefSpecialistTargets,
} from "./chief-specialist-consultation.js";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) {
      continue;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function makeWorkspaceRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chief-consult-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, "workspace-chief", "memory"), { recursive: true });
  await fs.mkdir(path.join(root, "workspace-work", "reports", "briefs"), { recursive: true });
  await fs.mkdir(path.join(root, "workspace-career", "reports", "briefs"), { recursive: true });
  await fs.mkdir(path.join(root, "workspace-personal", "reports", "briefs"), {
    recursive: true,
  });
  return root;
}

function buildConfig(root: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "openai-codex/gpt-5.4-mini",
        },
      },
      list: [
        {
          id: "chief",
          default: true,
          name: "Kai",
          workspace: path.join(root, "workspace-chief"),
          agentDir: path.join(root, "agents", "chief"),
        },
        {
          id: "work",
          name: "Malik",
          workspace: path.join(root, "workspace-work"),
          agentDir: path.join(root, "agents", "work"),
          model: { primary: "openai-codex/gpt-5.4-mini" },
        },
        {
          id: "career",
          name: "Leila",
          workspace: path.join(root, "workspace-career"),
          agentDir: path.join(root, "agents", "career"),
          model: { primary: "openai-codex/gpt-5.4-mini" },
        },
        {
          id: "personal",
          name: "Nour",
          workspace: path.join(root, "workspace-personal"),
          agentDir: path.join(root, "agents", "personal"),
          model: { primary: "openai-codex/gpt-5.4-mini" },
        },
      ],
    },
  } as OpenClawConfig;
}

describe("chief-specialist-consultation", () => {
  it("skips trivial greetings", async () => {
    const root = await makeWorkspaceRoot();
    const cfg = buildConfig(root);
    expect(resolveChiefSpecialistTargets({ cfg, userText: "hi" })).toEqual([]);
  });

  it("routes cross-domain requests to the relevant specialists", async () => {
    const root = await makeWorkspaceRoot();
    const cfg = buildConfig(root);
    const targets = resolveChiefSpecialistTargets({
      cfg,
      userText:
        "I want something good for me personally, my work, and my career. What should I do?",
    });
    expect(new Set(targets.map((item) => item.id))).toEqual(
      new Set(["career", "personal", "work"]),
    );
  });

  it("writes durable notes and returns a chief prompt block", async () => {
    const root = await makeWorkspaceRoot();
    const cfg = buildConfig(root);
    const runConsultation = vi.fn(async (params: { agentId: string }) => ({
      payloads: [
        {
          text: JSON.stringify({
            summary: `${params.agentId} summary`,
            recommendation: `${params.agentId} recommendation`,
            confidence: "high",
            evidence: [`${params.agentId} evidence`],
            risks: [`${params.agentId} risk`],
            follow_up: `${params.agentId} follow up`,
          }),
        },
      ],
    }));

    const chiefPrompt = await maybeBuildChiefSpecialistConsultationPrompt({
      cfg,
      chiefAgentId: "chief",
      chiefWorkspaceDir: path.join(root, "workspace-chief"),
      userText: "I need help with my work and career direction.",
      chiefTimeoutMs: 120_000,
      runConsultation,
    });

    expect(chiefPrompt).toContain(CHIEF_SPECIALIST_CONSULTATION_MARKER);
    expect(chiefPrompt).toContain("Malik (work) summary");
    expect(chiefPrompt).toContain("Leila (career) recommendation");
    expect(runConsultation).toHaveBeenCalledTimes(2);

    const chiefMemoryFiles = await fs.readdir(path.join(root, "workspace-chief", "memory"));
    expect(chiefMemoryFiles.some((file) => file.includes("chief-specialist-consult"))).toBe(true);

    const workBriefFiles = await fs.readdir(path.join(root, "workspace-work", "reports", "briefs"));
    expect(workBriefFiles.some((file) => file.includes("chief-consult-work"))).toBe(true);
  });

  it("does not duplicate the prompt block", () => {
    const prompt = `${CHIEF_SPECIALIST_CONSULTATION_MARKER}\n- existing`;
    expect(hasChiefSpecialistConsultationPrompt(prompt)).toBe(true);
    expect(appendChiefSpecialistConsultationPrompt(prompt, "new block")).toBe(prompt);
  });

  it("builds a chief synthesis block from structured consultations", () => {
    const prompt = buildChiefSpecialistConsultationSystemPrompt([
      {
        id: "work",
        name: "Malik",
        summary: "Tighten the execution scope.",
        recommendation: "Ship one narrow artifact.",
        confidence: "high",
        evidence: ["Past drift came from too many options."],
        risks: ["Still needs a concrete deadline."],
        followUp: "Define the artifact before coding.",
        rawText: "{}",
      },
    ]);
    expect(prompt).toContain(CHIEF_SPECIALIST_CONSULTATION_MARKER);
    expect(prompt).toContain("Do not mention internal consultation");
    expect(prompt).toContain("Malik (work) recommendation: Ship one narrow artifact.");
  });
});
