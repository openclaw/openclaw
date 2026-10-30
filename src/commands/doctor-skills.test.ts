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

  const processHome = "/agent/home";
  const serviceHome = "/var/lib/openclaw/agent";
  const windowsHome = "C:\\Users\\agent";
  const appData = `${windowsHome}\\AppData\\Roaming`;
  const windowsHosts = `${appData}\\GitHub CLI\\hosts.yml`;
  const legacyWindowsHosts = `${windowsHome}\\.config\\gh\\hosts.yml`;
  const xdgHosts = "/agent/xdg/gh/hosts.yml";
  type NoHintCase = [string, NodeJS.ProcessEnv, string?, NodeJS.Platform?, string?];

  async function githubHint(
    env: NodeJS.ProcessEnv,
    hosts?: string,
    platform: NodeJS.Platform = "linux",
  ) {
    Object.defineProperty(process, "platform", { value: platform });
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
    return calls.find((call) => call[1] === "GitHub CLI")?.[0];
  }

  it.each([
    ["sudo operator", { HOME: serviceHome, SUDO_USER: "alice" }, "/home/alice", "linux"],
    ["login operator", { HOME: serviceHome, USER: "ops" }, "/home/ops", "linux"],
    ["root operator", { HOME: processHome }, "/root", "linux"],
    ["macOS sudo operator", { HOME: processHome, SUDO_USER: "alice" }, "/Users/alice", "darwin"],
  ] as const)(
    "discovers the GitHub CLI hint for %s",
    async (_name, env, alternateHome, platform) => {
      const alternate = `${alternateHome}/.config/gh`;
      expect(await githubHint(env, `${alternate}/hosts.yml`, platform)).toBe(
        [
          "GitHub CLI auth was found at a different HOME than the one this OpenClaw process uses.",
          `  Process gh config dir: ${env.HOME}/.config/gh`,
          `  Authenticated config:  ${alternate} (contains hosts.yml)`,
          `  Authenticated HOME:    ${alternateHome}`,
          `  Fix: set GH_CONFIG_DIR=${alternate} on the OpenClaw service environment, then restart the gateway.`,
        ].join("\n"),
      );
    },
  );

  it.each<NoHintCase>([
    ["explicit config directory", { HOME: processHome, GH_CONFIG_DIR: "/etc/openclaw/gh" }],
    ["missing home", {}],
    ["no known auth", { HOME: processHome }, undefined, "linux", "/root/.config/gh/hosts.yml"],
    ["XDG precedence", { HOME: processHome, XDG_CONFIG_HOME: "/agent/xdg" }, xdgHosts],
    ["Windows APPDATA", { APPDATA: appData }, windowsHosts, "win32"],
    ["Windows profile fallback", { USERPROFILE: windowsHome }, windowsHosts, "win32"],
    ["Windows HOME fallback", { HOME: windowsHome }, legacyWindowsHosts, "win32"],
  ])(
    "does not emit a GitHub CLI hint for %s",
    async (_name, env, hosts, platform, checked = hosts) => {
      expect(await githubHint(env, hosts, platform)).toBeUndefined();
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
