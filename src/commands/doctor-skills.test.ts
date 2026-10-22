import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyInstallChecks } from "../cli/requirements-test-fixtures.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillStatusEntry, SkillStatusReport } from "../skills/discovery/status.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
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

function unavailable(name: string, missing: Partial<SkillStatusEntry["missing"]> = {}) {
  return createSkill({
    name,
    eligible: false,
    missing: { ...createEmptyInstallChecks().missing, ...missing },
  });
}

function createReport(skills: SkillStatusEntry[], agentId = "main"): SkillStatusReport {
  return {
    workspaceDir: "/tmp/ws",
    managedSkillsDir: "/tmp/managed",
    agentId,
    skills,
  };
}

function createPrompter(repair = false) {
  return createDoctorPrompter({
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    options: { repair, nonInteractive: true },
  });
}

async function runSkillDoctor(skills: SkillStatusEntry[]) {
  mocks.note.mockClear();
  mocks.buildWorkspaceSkillStatus.mockReturnValue(createReport(skills));
  await maybeRepairSkillReadiness({ cfg: {}, prompter: createPrompter() });
  return mocks.note.mock.calls;
}

describe("doctor skills", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["bins", "anyBins"] as const)(
    "preserves skills whose missing %s may be available on a paired node",
    async (requirement) => {
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
      mocks.note.mockClear();
      mocks.buildWorkspaceSkillStatus.mockReturnValue(
        createReport([unavailable("node-tool", { [requirement]: ["node-tool-bin"] })]),
      );
      const cfg: OpenClawConfig = {
        skills: { entries: { "node-tool": { enabled: true } } },
      };

      const next = await maybeRepairSkillReadiness({ cfg, prompter: createPrompter(true) });

      expect(next).toEqual(cfg);
      const output = mocks.note.mock.calls.map(([message]) => String(message)).join("\n");
      expect(output).toContain("node-tool");
      expect(output).not.toContain("Disable unused skills:");
    },
  );

  it.each([
    { mode: "update", update: true, expectedEnabled: true },
    { mode: "standalone repair", update: false, expectedEnabled: false },
  ])("honors skill-repair authority for $mode", async ({ update, expectedEnabled }) => {
    mocks.note.mockClear();
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", update ? "1" : undefined);
    mocks.buildWorkspaceSkillStatus.mockReturnValue(
      createReport([unavailable("optional-tool", { env: ["MISSING_TOOL_KEY"] })]),
    );
    const cfg: OpenClawConfig = {
      skills: { entries: { "optional-tool": { enabled: true, env: { EXISTING: "1" } } } },
    };

    const next = await maybeRepairSkillReadiness({ cfg, prompter: createPrompter(true) });

    expect(next.skills?.entries?.["optional-tool"]).toEqual({
      enabled: expectedEnabled,
      env: { EXISTING: "1" },
    });
    expect(cfg.skills?.entries?.["optional-tool"]?.enabled).toBe(true);
    const output = mocks.note.mock.calls.map(([message]) => String(message)).join("\n");
    expect(output.includes("Disable unused skills: openclaw doctor --fix")).toBe(update);
  });

  it("formats unavailable skill names compactly and alphabetically", async () => {
    const calls = await runSkillDoctor([
      {
        ...unavailable("places", { bins: ["goplaces"], env: ["GOOGLE_MAPS_API_KEY"] }),
        install: [
          { id: "brew", kind: "brew", label: "Install goplaces (brew)", bins: ["goplaces"] },
        ],
      },
      unavailable("calendar"),
    ]);

    const body = calls.find((call) => call[1] === "Skills")?.[0];
    expect(typeof body === "string" ? body.split("\n") : []).toEqual([
      "2 allowed skills are not usable in this environment (missing binaries, env vars, or config).",
      "- calendar, places",
      "Missing local binaries may exist on paired nodes; these skills remain enabled.",
      "Disable unused skills: openclaw doctor --fix",
      "Inspect details: openclaw skills check --agent <id> or openclaw skills info <name> --agent <id>",
    ]);
  });

  it("surfaces a GH_CONFIG_DIR hint through the doctor path", async () => {
    mocks.detectGhConfigDirMismatch.mockReturnValue({
      kind: "mismatch",
      effectiveConfigDir: "/agent/home/.config/gh",
      alternateConfigDir: "/root/.config/gh",
      alternateHomeHint: "/root",
    });
    const calls = await runSkillDoctor([createSkill({ name: "github" })]);
    const output = String(calls.find((call) => call[1] === "GitHub CLI")?.[0] ?? "");

    expect(output).toContain("/root/.config/gh");
    expect(output).toContain("GH_CONFIG_DIR=/root/.config/gh");
  });

  it.each(["eligible", "missing binary"])(
    "does not offer a global disable when another agent's skill is %s",
    async (readiness) => {
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
      mocks.note.mockClear();
      mocks.buildWorkspaceSkillStatus.mockClear();
      const otherAgentSkill =
        readiness === "eligible"
          ? createSkill({ name: "shared" })
          : unavailable("shared", { bins: ["shared-bin"] });
      const missing = unavailable("shared", { env: ["SHARED_TOOL_KEY"] });
      mocks.buildWorkspaceSkillStatus.mockImplementation((_workspaceDir, { agentId }) =>
        createReport(agentId === "secondary" ? [missing] : [otherAgentSkill], agentId),
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

      const next = await maybeRepairSkillReadiness({ cfg, prompter: createPrompter(true) });

      expect(next).toEqual(cfg);
      const output = mocks.note.mock.calls
        .filter(([, title]) => title === "Skills")
        .map(([message]) => String(message))
        .join("\n");
      expect(output).toContain('Agent "secondary"');
      expect(output).not.toContain("doctor --fix");
    },
  );
});
