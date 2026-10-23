import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyInstallChecks } from "../cli/requirements-test-fixtures.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillStatusEntry, SkillStatusReport } from "../skills/discovery/status.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import { maybeRepairSkillReadiness } from "./doctor-skills.js";

const mocks = vi.hoisted(() => ({
  buildWorkspaceSkillStatus: vi.fn(),
  fileExists: vi.fn<(_path: string) => boolean>(() => false),
  note: vi.fn(),
}));

vi.mock("../skills/discovery/status.js", async (importActual) => ({
  ...(await importActual<typeof import("../skills/discovery/status.js")>()),
  buildWorkspaceSkillStatus: mocks.buildWorkspaceSkillStatus,
}));
vi.mock("node:fs", async (importActual) => ({
  ...(await importActual<typeof import("node:fs")>()),
  existsSync: mocks.fileExists,
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
  const originalPlatform = process.platform;
  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, "platform", { value: originalPlatform });
    mocks.fileExists.mockReset().mockReturnValue(false);
  });

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

  it.each<{
    name: string;
    platform?: NodeJS.Platform;
    env: Record<string, string>;
    hosts?: string;
    effective?: string;
    alternateHome?: string;
    checked?: string;
  }>([
    {
      name: "explicit config directory",
      env: { HOME: "/agent/home", GH_CONFIG_DIR: "/etc/openclaw/gh" },
    },
    { name: "missing home", env: {} },
    {
      name: "sudo operator",
      env: { HOME: "/var/lib/openclaw/agent", SUDO_USER: "alice" },
      hosts: "/home/alice/.config/gh/hosts.yml",
      effective: "/var/lib/openclaw/agent/.config/gh",
      alternateHome: "/home/alice",
    },
    {
      name: "login operator",
      env: { HOME: "/var/lib/openclaw/agent", USER: "ops" },
      hosts: "/home/ops/.config/gh/hosts.yml",
      effective: "/var/lib/openclaw/agent/.config/gh",
      alternateHome: "/home/ops",
    },
    {
      name: "root operator",
      env: { HOME: "/agent/home" },
      hosts: "/root/.config/gh/hosts.yml",
      effective: "/agent/home/.config/gh",
      alternateHome: "/root",
    },
    {
      name: "no known auth",
      env: { HOME: "/agent/home" },
      checked: "/root/.config/gh/hosts.yml",
    },
    {
      name: "XDG precedence",
      env: { HOME: "/agent/home", XDG_CONFIG_HOME: "/agent/xdg" },
      hosts: "/agent/xdg/gh/hosts.yml",
      checked: "/agent/xdg/gh/hosts.yml",
    },
    {
      name: "Windows APPDATA",
      platform: "win32",
      env: { APPDATA: "C:\\Users\\agent\\AppData\\Roaming" },
      hosts: "C:\\Users\\agent\\AppData\\Roaming\\GitHub CLI\\hosts.yml",
      checked: "C:\\Users\\agent\\AppData\\Roaming\\GitHub CLI\\hosts.yml",
    },
    {
      name: "Windows profile fallback",
      platform: "win32",
      env: { USERPROFILE: "C:\\Users\\agent" },
      hosts: "C:\\Users\\agent\\AppData\\Roaming\\GitHub CLI\\hosts.yml",
      checked: "C:\\Users\\agent\\AppData\\Roaming\\GitHub CLI\\hosts.yml",
    },
    {
      name: "Windows HOME fallback",
      platform: "win32",
      env: { HOME: "C:\\Users\\agent" },
      hosts: "C:\\Users\\agent\\.config\\gh\\hosts.yml",
      checked: "C:\\Users\\agent\\.config\\gh\\hosts.yml",
    },
    {
      name: "macOS sudo operator",
      platform: "darwin",
      env: { HOME: "/agent/home", SUDO_USER: "alice" },
      hosts: "/Users/alice/.config/gh/hosts.yml",
      effective: "/agent/home/.config/gh",
      alternateHome: "/Users/alice",
    },
  ])(
    "discovers the GitHub CLI hint for $name",
    async ({ platform, env, hosts, effective, alternateHome, checked }) => {
      Object.defineProperty(process, "platform", { value: platform ?? "linux" });
      for (const key of [
        "HOME",
        "XDG_CONFIG_HOME",
        "GH_CONFIG_DIR",
        "APPDATA",
        "SUDO_USER",
        "USER",
        "USERPROFILE",
      ]) {
        vi.stubEnv(key, env[key]);
      }
      mocks.fileExists.mockImplementation((file) => file === hosts);
      const calls = await runSkillDoctor([createSkill({ name: "github" })]);
      const output = calls.find((call) => call[1] === "GitHub CLI")?.[0];
      if (alternateHome) {
        const alternate = `${alternateHome}/.config/gh`;
        expect(output).toBe(
          [
            "GitHub CLI auth was found at a different HOME than the one this OpenClaw process uses.",
            `  Process gh config dir: ${effective}`,
            `  Authenticated config:  ${alternate} (contains hosts.yml)`,
            `  Authenticated HOME:    ${alternateHome}`,
            `  Fix: set GH_CONFIG_DIR=${alternate} on the OpenClaw service environment, then restart the gateway.`,
          ].join("\n"),
        );
      } else {
        expect(output).toBeUndefined();
      }
      if (checked) {
        expect(mocks.fileExists).toHaveBeenCalledWith(checked);
      }
    },
  );

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
