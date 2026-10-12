// Doctor skills tests cover skill install checks, status summaries, and repair guidance.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyInstallChecks } from "../cli/requirements-test-fixtures.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillStatusEntry, SkillStatusReport } from "../skills/discovery/status.js";
import { createDoctorPrompter, type DoctorPrompter } from "./doctor-prompter.js";
import { maybeRepairSkillReadiness } from "./doctor-skills.js";

const mocks = vi.hoisted(() => ({
  buildWorkspaceSkillStatus: vi.fn(),
  detectGhConfigDirMismatch: vi.fn(),
  note: vi.fn(),
}));

vi.mock("../skills/discovery/status.js", async (importActual) => ({
  ...(await importActual<typeof import("../skills/discovery/status.js")>()),
  buildWorkspaceSkillStatus: mocks.buildWorkspaceSkillStatus,
}));
vi.mock("../skills/lifecycle/gh-config-discovery.js", async (importActual) => ({
  ...(await importActual<typeof import("../skills/lifecycle/gh-config-discovery.js")>()),
  detectGhConfigDirMismatch: mocks.detectGhConfigDirMismatch,
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

function createSkill(overrides: Partial<SkillStatusEntry>): SkillStatusEntry {
  return {
    name: "demo",
    description: "Demo",
    source: "test",
    bundled: false,
    filePath: "/tmp/demo/SKILL.md",
    baseDir: "/tmp/demo",
    skillKey: overrides.name ?? "demo",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: true,
    platformIncompatible: false,
    modelVisible: true,
    userInvocable: true,
    commandVisible: true,
    ...createEmptyInstallChecks(),
    ...overrides,
  };
}

function createReport(skills: SkillStatusEntry[], agentId = "main"): SkillStatusReport {
  return {
    workspaceDir: "/tmp/ws",
    managedSkillsDir: "/tmp/managed",
    agentId,
    skills,
  };
}

function createPrompter(): DoctorPrompter {
  return {
    confirm: vi.fn(async () => false),
    confirmAutoFix: vi.fn(async () => false),
    confirmAggressiveAutoFix: vi.fn(async () => false),
    confirmRuntimeRepair: vi.fn(async () => false),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair: false,
    shouldForce: false,
    repairMode: {
      shouldRepair: false,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    },
  };
}

function createRepairPrompter() {
  return createDoctorPrompter({
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    options: { repair: true, nonInteractive: true },
  });
}

async function runSkillDoctor(skills: SkillStatusEntry[]) {
  mocks.note.mockClear();
  mocks.buildWorkspaceSkillStatus.mockReturnValue(createReport(skills));
  await maybeRepairSkillReadiness({
    cfg: {},
    prompter: createPrompter(),
  });
  return mocks.note.mock.calls;
}

describe("doctor skills", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { mode: "update", update: true, available: false, expectedEnabled: true },
    { mode: "standalone repair", update: false, available: false, expectedEnabled: false },
  ])("honors skill-repair authority for $mode", async ({ update, available, expectedEnabled }) => {
    mocks.note.mockClear();
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", update ? "1" : undefined);
    mocks.buildWorkspaceSkillStatus.mockReturnValue(
      createReport([
        createSkill({
          name: "optional-tool",
          eligible: available,
          missing: {
            bins: available ? [] : ["missing-tool"],
            anyBins: [],
            env: [],
            config: [],
            os: [],
          },
        }),
      ]),
    );
    const cfg: OpenClawConfig = {
      skills: { entries: { "optional-tool": { enabled: true, env: { EXISTING: "1" } } } },
    };

    const next = await maybeRepairSkillReadiness({ cfg, prompter: createRepairPrompter() });

    expect(next.skills?.entries?.["optional-tool"]).toEqual({
      enabled: expectedEnabled,
      env: { EXISTING: "1" },
    });
    expect(cfg.skills?.entries?.["optional-tool"]?.enabled).toBe(true);
    const output = mocks.note.mock.calls.map(([message]) => String(message)).join("\n");
    expect(output.includes("Disable unused skills: openclaw doctor --fix")).toBe(
      update && !available,
    );
  });

  it("formats unavailable skill names compactly and alphabetically", async () => {
    const calls = await runSkillDoctor([
      createSkill({
        name: "places",
        eligible: false,
        platformIncompatible: false,
        missing: {
          bins: ["goplaces"],
          anyBins: [],
          env: ["GOOGLE_MAPS_API_KEY"],
          config: [],
          os: [],
        },
        install: [
          {
            id: "brew",
            kind: "brew",
            label: "Install goplaces (brew)",
            bins: ["goplaces"],
          },
        ],
      }),
      createSkill({
        name: "calendar",
        eligible: false,
        platformIncompatible: false,
      }),
    ]);

    const body = calls.find((call) => call[1] === "Skills")?.[0];
    expect(typeof body === "string" ? body.split("\n") : []).toEqual([
      "2 allowed skills are not usable in this environment (missing binaries, env vars, or config).",
      "- calendar, places",
      "Disable unused skills: openclaw doctor --fix",
      "Inspect details: openclaw skills check --agent <id> or openclaw skills info <name> --agent <id>",
    ]);
  });

  it("surfaces a GH_CONFIG_DIR hint through the doctor path", async () => {
    const githubSkill = createSkill({
      name: "github",
      skillKey: "github",
      eligible: true,
      platformIncompatible: false,
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
    });
    mocks.detectGhConfigDirMismatch.mockReturnValue({
      kind: "mismatch",
      effectiveConfigDir: "/agent/home/.config/gh",
      alternateConfigDir: "/root/.config/gh",
      alternateHostsFile: "/root/.config/gh/hosts.yml",
      alternateHomeHint: "/root",
      suggestedEnvValue: "/root/.config/gh",
    });
    const calls = await runSkillDoctor([githubSkill]);
    const output = String(calls.find((call) => call[1] === "GitHub CLI")?.[0] ?? "");

    expect(output).toContain("/root/.config/gh");
    expect(output).toContain("GH_CONFIG_DIR=/root/.config/gh");
  });

  it("does not offer a global disable when another agent can use the skill", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    mocks.note.mockClear();
    mocks.buildWorkspaceSkillStatus.mockClear();
    const healthy = createSkill({ name: "shared", skillKey: "shared" });
    const missing = createSkill({
      name: "shared",
      skillKey: "shared",
      eligible: false,
      missing: { bins: ["shared-bin"], anyBins: [], env: [], config: [], os: [] },
    });
    mocks.buildWorkspaceSkillStatus.mockImplementation((_workspaceDir, { agentId }) =>
      createReport(agentId === "secondary" ? [missing] : [healthy], agentId),
    );
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          main: { workspace: "/tmp/main" },
          secondary: { workspace: "/tmp/secondary" },
        },
      },
      skills: { entries: { shared: { enabled: true } } },
    };

    const next = await maybeRepairSkillReadiness({ cfg, prompter: createRepairPrompter() });

    expect(next).toEqual(cfg);
    expect(next.skills?.entries?.shared?.enabled).toBe(true);
    expect(mocks.buildWorkspaceSkillStatus).toHaveBeenCalledTimes(2);
    expect(
      String(mocks.note.mock.calls.find(([, title]) => title === "Skills")?.[0] ?? ""),
    ).toContain('Agent "secondary"');
    expect(
      String(mocks.note.mock.calls.find(([, title]) => title === "Skills")?.[0] ?? ""),
    ).not.toContain("doctor --fix");
  });
});
