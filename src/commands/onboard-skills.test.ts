import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { SkillInstallOption } from "../skills/discovery/status.types.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";

const mocks = vi.hoisted(() => ({
  buildWorkspaceSkillStatus: vi.fn(),
  installSkill: vi.fn(),
  resolveInstallerKindReadiness: vi.fn(),
  detectBinary: vi.fn(),
  isContainerEnvironment: vi.fn(),
  resolveBrewExecutable: vi.fn(),
}));

vi.mock("../skills/discovery/status.js", () => ({
  buildWorkspaceSkillStatus: mocks.buildWorkspaceSkillStatus,
}));
vi.mock("../skills/lifecycle/install.js", () => ({
  installSkill: mocks.installSkill,
  resolveInstallerKindReadiness: mocks.resolveInstallerKindReadiness,
  MIN_AUTO_GO_VERSION: "1.21",
}));
vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment: mocks.isContainerEnvironment,
}));
vi.mock("../infra/brew.js", () => ({
  resolveBrewExecutable: mocks.resolveBrewExecutable,
}));
vi.mock("./onboard-helpers.js", () => ({
  detectBinary: mocks.detectBinary,
}));

import { setupSkills } from "./onboard-skills.js";

function createBundledSkill(params: {
  name: string;
  description?: string;
  bins?: string[];
  installLabel?: string;
  installKind?: SkillInstallOption["kind"];
}) {
  const bins = params.bins ?? [params.name];
  return {
    name: params.name,
    description: params.description ?? params.name,
    source: "openclaw-bundled",
    bundled: true,
    disabled: false,
    blockedByAllowlist: false,
    eligible: false,
    missing: { bins, os: [] },
    install: [
      {
        id: params.installKind ?? "brew",
        kind: params.installKind ?? "brew",
        label: params.installLabel ?? `Install ${params.name}`,
        bins,
      },
    ],
  };
}

function createNodeSkill() {
  return createBundledSkill({ name: "node-helper", installKind: "node" });
}

const createBrewSkill = () => createBundledSkill({ name: "video-frames", bins: ["ffmpeg"] });

function createWorkspaceSkill(
  params: Parameters<typeof createBundledSkill>[0],
): ReturnType<typeof createBundledSkill> {
  return {
    ...createBundledSkill(params),
    source: "openclaw-workspace",
    bundled: false,
  };
}

function mockMissingBrewStatus(skills: Array<ReturnType<typeof createBundledSkill>>): void {
  mocks.detectBinary.mockResolvedValue(false);
  mocks.resolveBrewExecutable.mockReturnValue(undefined);
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

function createPrompter(params: { multiselect?: string[] }) {
  const notes: Array<{ title?: string; message: string }> = [];

  const prompter: WizardPrompter = makePrompter({
    note: vi.fn(async (message: string, title?: string) => {
      notes.push({ title, message });
    }),
    multiselect: vi.fn(
      async () => params.multiselect ?? ["__skip__"],
    ) as unknown as WizardPrompter["multiselect"],
  });

  return {
    prompter,
    notes,
    choices: () => vi.mocked(prompter.multiselect).mock.calls[0]?.[0].options ?? [],
    run: (config: OpenClawConfig = {}, options?: Parameters<typeof setupSkills>[4]) =>
      setupSkills(config, "/tmp/ws", runtime, prompter, options),
  };
}

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: ((code: number) => {
    throw new Error(`unexpected exit ${code}`);
  }) as RuntimeEnv["exit"],
};

const supportsHomebrewPrompt = process.platform === "darwin" || process.platform === "linux";

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
}

describe("setupSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isContainerEnvironment.mockReset();
    mocks.resolveBrewExecutable.mockReset();
    mocks.resolveInstallerKindReadiness.mockReset();
    mocks.resolveInstallerKindReadiness.mockResolvedValue({ ready: true });
  });

  it("bounds skill hints and install failures through the onboarding flow", async () => {
    const hintPrefix = "x".repeat(88);
    const failurePrefix = "y".repeat(138);
    mockMissingBrewStatus([
      createBundledSkill({
        name: "node-helper",
        description: `${hintPrefix}🚀tail`,
        bins: ["node-helper"],
        installLabel: "",
        installKind: "node",
      }),
    ]);
    mocks.installSkill.mockResolvedValueOnce({
      ok: false,
      message: `Install failed: ${failurePrefix}🚀tail`,
      stdout: "",
      stderr: "",
      code: 1,
    });
    const stop = vi.fn();
    const { prompter, run, choices } = createPrompter({ multiselect: ["node-helper"] });
    vi.mocked(prompter.progress).mockReturnValue({ update: vi.fn(), stop });

    await run();
    expect(choices().find((option) => option.value === "node-helper")?.hint).toBe(`${hintPrefix}…`);
    expect(stop).toHaveBeenCalledWith(expect.stringContaining(`${failurePrefix}…`));
  });

  it.each([undefined, "/home/linuxbrew/.linuxbrew/bin/brew"])(
    "offers container brew installs only when brew resolves (%s)",
    async (brew) => {
      await withPlatform("linux", async () => {
        mockMissingBrewStatus([createBrewSkill()]);
        mocks.isContainerEnvironment.mockReturnValue(true);
        mocks.resolveBrewExecutable.mockReturnValue(brew);

        const { prompter, notes, run } = createPrompter({ multiselect: ["video-frames"] });
        await run();

        if (brew) {
          expect(prompter.multiselect).toHaveBeenCalled();
          expect(mocks.installSkill).toHaveBeenCalledWith(
            expect.objectContaining({ skillName: "video-frames", installId: "brew" }),
          );
          expect(notes.find((n) => n.title === "Container skill installs")).toBeUndefined();
        } else {
          expect(prompter.multiselect).not.toHaveBeenCalled();
          expect(mocks.installSkill).not.toHaveBeenCalled();
          expect(notes.find((n) => n.title === "Container skill installs")).toBeDefined();
          expect(notes.some((n) => n.message.includes("No missing skill dependencies"))).toBe(
            false,
          );
        }
        expect(notes.find((n) => n.title === "Homebrew recommended")).toBeUndefined();
      });
    },
  );

  it.each(["__skip__", "nano-pdf"])(
    "offers only bundled recipes and checks prerequisites after selection (%s)",
    async (selected) => {
      await withPlatform("linux", async () => {
        mockMissingBrewStatus([
          createWorkspaceSkill({
            name: "repo-helper",
            installKind: "node",
          }),
          createNodeSkill(),
          createBundledSkill({
            name: "nano-pdf",
            installKind: "uv",
          }),
        ]);
        mocks.resolveInstallerKindReadiness.mockImplementation(async (kind: string) =>
          kind === "uv" ? { ready: false, reason: "uv" } : { ready: true },
        );

        const { prompter, notes, run, choices } = createPrompter({ multiselect: [selected] });
        await run();
        expect(choices().map(({ value }) => value)).toEqual(
          expect.arrayContaining(["__skip__", "node-helper", "nano-pdf"]),
        );
        expect(choices().map(({ value }) => value)).not.toContain("repo-helper");
        expect(mocks.installSkill).not.toHaveBeenCalled();
        expect(notes.find((note) => note.title === "Homebrew recommended")).toBeUndefined();
        if (selected === "__skip__") {
          expect(mocks.resolveInstallerKindReadiness).not.toHaveBeenCalled();
          expect(notes.find((note) => note.title === "Manual skill prerequisites")).toBeUndefined();
          return;
        }
        expect(mocks.resolveInstallerKindReadiness.mock.calls).toEqual([["uv"]]);
        expect(mocks.resolveInstallerKindReadiness.mock.invocationCallOrder[0]).toBeGreaterThan(
          vi.mocked(prompter.multiselect).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(
          notes.find((note) => note.title === "Manual skill prerequisites")?.message,
        ).toContain("uv: nano-pdf");
        const manualNoteCall = vi
          .mocked(prompter.note)
          .mock.calls.findIndex(([, title]) => title === "Manual skill prerequisites");
        expect(vi.mocked(prompter.note).mock.invocationCallOrder[manualNoteCall]).toBeGreaterThan(
          vi.mocked(prompter.multiselect).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
      });
    },
  );

  it("installs only the bundled dependencies selected by the user", async () => {
    mockMissingBrewStatus([
      createNodeSkill(),
      createBundledSkill({
        name: "other-helper",
        installKind: "node",
      }),
    ]);

    const beforePersistentEffect = vi.fn(async () => {});
    const { run } = createPrompter({ multiselect: ["__skip__", "node-helper"] });
    await run({}, { beforePersistentEffect });

    expect(beforePersistentEffect).toHaveBeenCalledOnce();
    expect(beforePersistentEffect.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.installSkill.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    expect(mocks.installSkill).toHaveBeenCalledTimes(1);
    expect(mocks.installSkill).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: "node-helper", installId: "node" }),
    );
  });

  it.each([
    [undefined, undefined, "npm"],
    ["yarn", undefined, "yarn"],
  ] as const)(
    "installs with saved %s and requested %s using %s",
    async (saved, requested, expected) => {
      mockMissingBrewStatus([createNodeSkill()]);

      const { run } = createPrompter({ multiselect: ["node-helper"] });
      const next = await run(
        { skills: { install: { nodeManager: saved } } },
        { nodeManager: requested },
      );

      expect(next.skills?.install?.nodeManager).toBe(expected);
      expect(mocks.installSkill.mock.calls[0]?.[0]).toMatchObject({
        skillName: "node-helper",
        installId: "node",
        config: { skills: { install: { nodeManager: expected } } },
      });
    },
  );

  it("does not run brew-backed installs when brew is missing", async () => {
    if (!supportsHomebrewPrompt) {
      return;
    }

    mockMissingBrewStatus([createBrewSkill()]);
    mocks.resolveInstallerKindReadiness.mockResolvedValue({ ready: false, reason: "brew" });

    const { notes, run } = createPrompter({ multiselect: ["video-frames"] });
    await run();

    const brewNote = notes.find((n) => n.title === "Homebrew recommended");
    expect(brewNote?.title).toBe("Homebrew recommended");
    expect(mocks.installSkill).not.toHaveBeenCalled();
    const manualNote = notes.find((n) => n.title === "Manual skill prerequisites");
    expect(manualNote?.message).toContain("Homebrew: video-frames");
  });

  it("groups Go prerequisite skips discovered after policy approval", async () => {
    await withPlatform("linux", async () => {
      mockMissingBrewStatus([
        createBundledSkill({
          name: "blogwatcher",
          installKind: "go",
        }),
      ]);
      mocks.installSkill.mockResolvedValueOnce({
        ok: false,
        message:
          "Install failed (exit 1): go: blogwatcher requires go >= 1.24 (running go 1.22; GOTOOLCHAIN=local)",
        stdout: "",
        stderr: "",
        code: null,
        skipReason: "go",
      });

      const { notes, run } = createPrompter({ multiselect: ["blogwatcher"] });
      await run();

      expect(mocks.installSkill).toHaveBeenCalledTimes(1);
      const manualNote = notes.find((n) => n.title === "Manual skill prerequisites");
      expect(manualNote?.message).toContain("Go toolchain (1.21+): blogwatcher");
      expect(manualNote?.message).toContain(
        "blogwatcher: go: blogwatcher requires go >= 1.24 (running go 1.22; GOTOOLCHAIN=local)",
      );
      expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Docs:"));
    });
  });

  it("displays a clear empty state note when all skill dependencies are ready", async () => {
    mockMissingBrewStatus([]);

    const { prompter, notes, run } = createPrompter({});
    await run();

    expect(prompter.multiselect).not.toHaveBeenCalled();
    const emptyStateNote = notes.find((n) => n.title === "All skills ready");
    expect(emptyStateNote?.message).toContain("No missing skill dependencies to install");
    expect(emptyStateNote?.message).toContain("openclaw skills list --verbose");
    expect(emptyStateNote?.message).toContain("openclaw skills check");
  });
});
