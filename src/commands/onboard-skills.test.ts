import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const mocks = vi.hoisted(() => ({
  buildWorkspaceSkillStatus: vi.fn(),
  installSkill: vi.fn(),
  detectBinary: vi.fn(),
  resolveNodeManagerOptions: vi.fn(() => [
    { value: "npm", label: "npm" },
    { value: "pnpm", label: "pnpm" },
    { value: "bun", label: "bun" },
  ]),
}));

// Module under test imports these at module scope.
vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: mocks.buildWorkspaceSkillStatus,
}));
vi.mock("../agents/skills-install.js", () => ({
  installSkill: mocks.installSkill,
}));
vi.mock("./onboard-helpers.js", () => ({
  detectBinary: mocks.detectBinary,
  resolveNodeManagerOptions: mocks.resolveNodeManagerOptions,
}));

import { setupSkills } from "./onboard-skills.js";

function createBundledSkill(params: {
  name: string;
  description: string;
  bins: string[];
  os?: string[];
  installLabel: string;
  primaryEnv?: string;
  envMissing?: string[];
}): {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  filePath: string;
  baseDir: string;
  skillKey: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: { bins: string[]; anyBins: string[]; env: string[]; config: string[]; os: string[] };
  configChecks: [];
  install: Array<{ id: string; kind: string; label: string; bins: string[] }>;
  primaryEnv?: string;
} {
  const env = params.envMissing ?? [];
  return {
    name: params.name,
    description: params.description,
    source: "openclaw-bundled",
    bundled: true,
    filePath: `/tmp/skills/${params.name}`,
    baseDir: `/tmp/skills/${params.name}`,
    skillKey: params.name,
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: false,
    requirements: { bins: params.bins, anyBins: [], env, config: [], os: params.os ?? [] },
    missing: { bins: params.bins, anyBins: [], env, config: [], os: params.os ?? [] },
    configChecks: [],
    install: [{ id: "brew", kind: "brew", label: params.installLabel, bins: params.bins }],
    ...(params.primaryEnv ? { primaryEnv: params.primaryEnv } : {}),
  };
}

function mockMissingBrewStatus(skills: Array<ReturnType<typeof createBundledSkill>>): void {
  mocks.detectBinary.mockResolvedValue(false);
  mocks.installSkill.mockResolvedValue({
    ok: true,
    message: "Installed",
    stdout: "",
    stderr: "",
    code: 0,
  });
  mocks.buildWorkspaceSkillStatus.mockReturnValue({
    workspaceDir: "/tmp/ws",
    managedSkillsDir: "/tmp/managed",
    skills,
  } as never);
}

function createPrompter(params: {
  configure?: boolean;
  showBrewInstall?: boolean;
  multiselect?: string[];
}): { prompter: WizardPrompter; notes: Array<{ title?: string; message: string }> } {
  const notes: Array<{ title?: string; message: string }> = [];

  const confirmAnswers: boolean[] = [];
  confirmAnswers.push(params.configure ?? true);

  const prompter: WizardPrompter = {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async (message: string, title?: string) => {
      notes.push({ title, message });
    }),
    select: vi.fn(async () => "npm") as unknown as WizardPrompter["select"],
    multiselect: vi.fn(
      async () => params.multiselect ?? ["__skip__"],
    ) as unknown as WizardPrompter["multiselect"],
    text: vi.fn(async () => ""),
    confirm: vi.fn(async ({ message }) => {
      if (message === "Show Homebrew install command?") {
        return params.showBrewInstall ?? false;
      }
      return confirmAnswers.shift() ?? false;
    }),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };

  return { prompter, notes };
}

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: ((code: number) => {
    throw new Error(`unexpected exit ${code}`);
  }) as RuntimeEnv["exit"],
};

describe("setupSkills", () => {
  it("does not recommend Homebrew when user skips installing brew-backed deps", async () => {
    if (process.platform === "win32") {
      return;
    }

    mockMissingBrewStatus([
      createBundledSkill({
        name: "apple-reminders",
        description: "macOS-only",
        bins: ["remindctl"],
        os: ["darwin"],
        installLabel: "Install remindctl (brew)",
      }),
      createBundledSkill({
        name: "video-frames",
        description: "ffmpeg",
        bins: ["ffmpeg"],
        installLabel: "Install ffmpeg (brew)",
      }),
    ]);

    const { prompter, notes } = createPrompter({ multiselect: ["__skip__"] });
    await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

    // OS-mismatched skill should be counted as unsupported, not installable/missing.
    const status = notes.find((n) => n.title === "Skills status")?.message ?? "";
    expect(status).toContain("Unsupported on this OS: 1");

    const brewNote = notes.find((n) => n.title === "Homebrew recommended");
    expect(brewNote).toBeUndefined();
  });

  it("recommends Homebrew when user selects a brew-backed install and brew is missing", async () => {
    if (process.platform === "win32") {
      return;
    }

    mockMissingBrewStatus([
      createBundledSkill({
        name: "video-frames",
        description: "ffmpeg",
        bins: ["ffmpeg"],
        installLabel: "Install ffmpeg (brew)",
      }),
    ]);

    const { prompter, notes } = createPrompter({ multiselect: ["video-frames"] });
    await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

    const brewNote = notes.find((n) => n.title === "Homebrew recommended");
    expect(brewNote).toBeDefined();
  });

  it("does not prompt for an API key when the user skips installing the binary deps for that skill", async () => {
    if (process.platform === "win32") {
      return;
    }

    mockMissingBrewStatus([
      createBundledSkill({
        name: "openai-whisper",
        description: "Local whisper CLI (no API key)",
        bins: ["whisper"],
        installLabel: "Install OpenAI Whisper (brew)",
      }),
      createBundledSkill({
        name: "openai-whisper-api",
        description: "OpenAI Whisper API",
        bins: ["curl"],
        installLabel: "Install curl (brew)",
        primaryEnv: "OPENAI_API_KEY",
        envMissing: ["OPENAI_API_KEY"],
      }),
    ]);

    const { prompter } = createPrompter({ multiselect: ["openai-whisper"] });
    await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

    const confirmCalls = (
      prompter.confirm as unknown as { mock: { calls: Array<[{ message: string }]> } }
    ).mock.calls;
    const askedForApiKey = confirmCalls.some(([arg]) => arg.message.includes("Set OPENAI_API_KEY"));
    expect(askedForApiKey).toBe(false);
  });

  it("still prompts for an API key when the user opts to install the matching skill", async () => {
    if (process.platform === "win32") {
      return;
    }

    mockMissingBrewStatus([
      createBundledSkill({
        name: "openai-whisper-api",
        description: "OpenAI Whisper API",
        bins: ["curl"],
        installLabel: "Install curl (brew)",
        primaryEnv: "OPENAI_API_KEY",
        envMissing: ["OPENAI_API_KEY"],
      }),
    ]);

    const { prompter } = createPrompter({ multiselect: ["openai-whisper-api"] });
    await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

    const confirmCalls = (
      prompter.confirm as unknown as { mock: { calls: Array<[{ message: string }]> } }
    ).mock.calls;
    const askedForApiKey = confirmCalls.some(([arg]) => arg.message.includes("Set OPENAI_API_KEY"));
    expect(askedForApiKey).toBe(true);
  });

  it("does not prompt for an API key for an env-only-missing skill the user did not select", async () => {
    if (process.platform === "win32") {
      return;
    }

    mockMissingBrewStatus([
      createBundledSkill({
        name: "openai-whisper",
        description: "Local whisper CLI (no API key)",
        bins: ["whisper"],
        installLabel: "Install OpenAI Whisper (brew)",
      }),
      createBundledSkill({
        name: "openai-whisper-api",
        description: "OpenAI Whisper API (curl already present)",
        bins: [],
        installLabel: "Install curl (brew)",
        primaryEnv: "OPENAI_API_KEY",
        envMissing: ["OPENAI_API_KEY"],
      }),
    ]);

    const { prompter } = createPrompter({ multiselect: ["openai-whisper"] });
    await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

    const confirmCalls = (
      prompter.confirm as unknown as { mock: { calls: Array<[{ message: string }]> } }
    ).mock.calls;
    const askedForApiKey = confirmCalls.some(([arg]) => arg.message.includes("Set OPENAI_API_KEY"));
    expect(askedForApiKey).toBe(false);
  });

  it("prompts for an API key for an env-only-missing skill the user explicitly selected", async () => {
    if (process.platform === "win32") {
      return;
    }

    mockMissingBrewStatus([
      createBundledSkill({
        name: "openai-whisper-api",
        description: "OpenAI Whisper API (curl already present)",
        bins: [],
        installLabel: "Install curl (brew)",
        primaryEnv: "OPENAI_API_KEY",
        envMissing: ["OPENAI_API_KEY"],
      }),
    ]);

    const { prompter } = createPrompter({ multiselect: ["openai-whisper-api"] });
    mocks.installSkill.mockClear();
    await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

    const confirmCalls = (
      prompter.confirm as unknown as { mock: { calls: Array<[{ message: string }]> } }
    ).mock.calls;
    const askedForApiKey = confirmCalls.some(([arg]) => arg.message.includes("Set OPENAI_API_KEY"));
    expect(askedForApiKey).toBe(true);
    // Install loop must not run installSkill for env-only entries.
    expect(mocks.installSkill).not.toHaveBeenCalled();
  });

  it("still prompts for an API key for a skill with missing bins + primaryEnv but no install options (codex follow-up on PR #74891)", async () => {
    if (process.platform === "win32") {
      return;
    }

    // Documented pattern in docs/tools/skills.md: a skill can require bins +
    // primaryEnv without an install block. Such skills are NEVER offered in
    // the install multiselect (they're filtered out of `installable` because
    // install.length === 0, and out of `envOnlyConfigurable` because
    // missing.bins.length > 0). The previous gate `!installSelected.has(...)`
    // silently skipped the API-key prompt for those skills. After the fix,
    // the gate only fires when the skill was actually presented in the
    // multiselect, so non-installable bin+env skills still get prompted for
    // their required env key.
    const noInstallSkill = createBundledSkill({
      name: "openai-whisper-no-install",
      description: "Skill that requires bins + an API key but has no install options",
      bins: ["nonexistent-bin"],
      installLabel: "unused",
      primaryEnv: "OPENAI_API_KEY",
      envMissing: ["OPENAI_API_KEY"],
    });
    // Override the install array to be empty — the documented bin-only
    // no-install pattern. The helper always sets a brew install entry.
    (noInstallSkill as { install: unknown[] }).install = [];

    mockMissingBrewStatus([noInstallSkill]);

    // No multiselect interaction expected — when configurable is empty the
    // prompter never gets called for it; the API-key prompt should still run
    // for the unpresentable skill below it.
    const { prompter } = createPrompter({ multiselect: [] });
    await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

    const confirmCalls = (
      prompter.confirm as unknown as { mock: { calls: Array<[{ message: string }]> } }
    ).mock.calls;
    const askedForApiKey = confirmCalls.some(([arg]) => arg.message.includes("Set OPENAI_API_KEY"));
    expect(askedForApiKey).toBe(true);
  });
});
