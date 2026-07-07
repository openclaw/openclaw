import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter, WizardSelectParams } from "../wizard/prompts.js";
import { runGuidedOnboarding, type GuidedOnboardingDeps } from "./onboard-guided.js";

vi.mock("../../packages/terminal-core/src/restore.js", () => ({
  restoreTerminalState: vi.fn(),
}));

vi.mock("./onboard-interactive-runner.js", async (importActual) => {
  const actual = await importActual<typeof import("./onboard-interactive-runner.js")>();
  return { ...actual, hasInteractiveOnboardingTty: () => true };
});

const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({ exists: false, valid: true, config: {} })),
);

vi.mock("../config/config.js", () => ({ readConfigFileSnapshot }));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/openclaw-workspace",
  printWizardHeader: vi.fn(),
}));

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  };
}

function candidate(kind: "claude-cli" | "codex-cli", label: string) {
  return {
    kind,
    label,
    detail: "logged in",
    modelRef: kind === "claude-cli" ? "claude-cli/opus" : "openai/gpt-5.5",
    recommended: kind === "claude-cli",
    credentials: true,
  } as const;
}

function detection(
  overrides: Partial<Awaited<ReturnType<NonNullable<GuidedOnboardingDeps["detect"]>>>> = {},
) {
  return {
    candidates: [candidate("claude-cli", "Claude Code")],
    manualProviders: [],
    workspace: "/tmp/openclaw-workspace",
    setupComplete: false,
    ...overrides,
  };
}

function setupDeps(params: {
  prompter: WizardPrompter;
  detect?: GuidedOnboardingDeps["detect"];
  activate?: GuidedOnboardingDeps["activate"];
  applySetup?: GuidedOnboardingDeps["applySetup"];
  runClassicSetup?: GuidedOnboardingDeps["runClassicSetup"];
  runCrestodianChat?: GuidedOnboardingDeps["runCrestodianChat"];
}) {
  return {
    createPrompter: () => params.prompter,
    detect: params.detect ?? vi.fn(async () => detection()),
    activate:
      params.activate ??
      vi.fn(async () => ({
        ok: true as const,
        modelRef: "claude-cli/opus",
        latencyMs: 1250,
        lines: ["Workspace: /tmp/work", "Gateway: running"],
      })),
    applySetup: params.applySetup,
    runClassicSetup: params.runClassicSetup,
    runCrestodianChat: params.runCrestodianChat,
    launchTui: vi.fn(async () => {}),
  } satisfies GuidedOnboardingDeps;
}

describe("runGuidedOnboarding", () => {
  beforeEach(() => {
    readConfigFileSnapshot.mockReset();
    readConfigFileSnapshot.mockResolvedValue({ exists: false, valid: true, config: {} });
  });

  it("auto-connects one credentialed candidate and completes without manual setup", async () => {
    const select = vi.fn(async () => "unexpected") as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({
      text: vi.fn(async () => "/tmp/work"),
      select,
      confirm: vi.fn(async () => false),
    });
    const deps = setupDeps({ prompter });

    await runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps);

    expect(deps.activate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "claude-cli", workspace: "/tmp/work", surface: "cli" }),
    );
    expect(select).not.toHaveBeenCalled();
    expect(prompter.outro).toHaveBeenCalledWith("OpenClaw is ready.");
  });

  it("falls through after an auth failure and surfaces both outcomes", async () => {
    const prompter = createWizardPrompter({
      text: vi.fn(async () => "/tmp/work"),
      confirm: vi.fn(async () => false),
    });
    const activate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "login expired" })
      .mockResolvedValueOnce({
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 900,
        lines: ["Gateway: running"],
      }) as GuidedOnboardingDeps["activate"];
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [candidate("claude-cli", "Claude Code"), candidate("codex-cli", "Codex")],
        }),
      ),
      activate,
    });

    await runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps);

    expect(activate).toHaveBeenCalledTimes(2);
    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(notes).toContain("Claude Code");
    expect(notes).toContain("Authentication failed");
    expect(notes).toContain("Gateway: running");
  });

  it("offers an auto-attempted transient failure for manual retry", async () => {
    const select = vi.fn(async (params: WizardSelectParams) => {
      expect(params.options).toContainEqual(
        expect.objectContaining({
          value: "candidate:claude-cli",
          label: "Retry Claude Code (logged in)",
        }),
      );
      return "candidate:claude-cli";
    }) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({
      text: vi.fn(async () => "/tmp/work"),
      select,
      confirm: vi.fn(async () => false),
    });
    const activate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: "rate_limit", error: "try later" })
      .mockResolvedValueOnce({
        ok: true,
        modelRef: "claude-cli/opus",
        latencyMs: 700,
        lines: ["Gateway: running"],
      }) as GuidedOnboardingDeps["activate"];
    const deps = setupDeps({ prompter, activate });

    await runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps);

    expect(activate).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledOnce();
    expect(prompter.outro).toHaveBeenCalledWith("OpenClaw is ready.");
  });

  it("accepts and verifies a manual provider key without displaying it", async () => {
    const enteredValue = "synthetic-value";
    const text = vi.fn().mockResolvedValueOnce("/tmp/work").mockResolvedValueOnce(enteredValue);
    const select = vi.fn(
      async () => "manual:openai-api-key",
    ) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({
      text: text as WizardPrompter["text"],
      select,
      confirm: vi.fn(async () => false),
    });
    const activate = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 500,
      lines: ["Default model: openai/gpt-5.5"],
    })) as GuidedOnboardingDeps["activate"];
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [],
          manualProviders: [{ id: "openai-api-key", label: "OpenAI", hint: "API key" }],
        }),
      ),
      activate,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true }, runtime, deps);

    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "api-key",
        authChoice: "openai-api-key",
        apiKey: enteredValue,
      }),
    );
    expect(text).toHaveBeenLastCalledWith(expect.objectContaining({ sensitive: true }));
    expect(JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      enteredValue,
    );
    expect(JSON.stringify([runtime.log, runtime.error])).not.toContain(enteredValue);
  });

  it("can skip AI after a manual key fails", async () => {
    const text = vi.fn().mockResolvedValueOnce("/tmp/work").mockResolvedValueOnce("bad-key");
    const select = vi
      .fn()
      .mockResolvedValueOnce("manual:openai-api-key")
      .mockResolvedValueOnce("action:skip") as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({
      text: text as WizardPrompter["text"],
      select,
      confirm: vi.fn(async () => false),
    });
    const applySetup = vi.fn<NonNullable<GuidedOnboardingDeps["applySetup"]>>(async () => ({
      configPath: "/tmp/config",
      lines: ["Workspace"],
    }));
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [],
          manualProviders: [{ id: "openai-api-key", label: "OpenAI" }],
        }),
      ),
      activate: vi.fn(async () => ({
        ok: false as const,
        status: "auth" as const,
        error: "bad key",
      })),
      applySetup,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true }, runtime, deps);

    expect(applySetup).toHaveBeenCalledWith({
      workspace: "/tmp/work",
      surface: "cli",
      runtime,
    });
    expect(applySetup.mock.calls[0]?.[0]).not.toHaveProperty("model");
  });

  it("hands the original options to the classic wizard escape", async () => {
    const opts = { acceptRisk: true, workspace: "/tmp/original" };
    const select = vi.fn(async () => "action:classic") as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ text: vi.fn(async () => "/tmp/work"), select });
    const runClassicSetup = vi.fn(async () => {});
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () => detection({ candidates: [] })),
      runClassicSetup,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding(opts, runtime, deps);

    expect(runClassicSetup).toHaveBeenCalledWith(opts, runtime);
  });

  it("opens Crestodian chat with the selected workspace", async () => {
    const select = vi.fn(async () => "action:crestodian") as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ text: vi.fn(async () => "/tmp/work"), select });
    const runCrestodianChat = vi.fn(async () => {});
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () => detection({ candidates: [] })),
      runCrestodianChat,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true }, runtime, deps);

    expect(runCrestodianChat).toHaveBeenCalledWith("/tmp/work", runtime);
  });

  it("cancels before detection or activation when risk is declined", async () => {
    const prompter = createWizardPrompter({ confirm: vi.fn(async () => false) });
    const deps = setupDeps({ prompter });
    const runtime = makeRuntime();

    await runGuidedOnboarding({}, runtime, deps);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it("opens Crestodian without writing when existing config is invalid", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      config: {},
    });
    const prompter = createWizardPrompter();
    const runCrestodianChat = vi.fn(async () => {});
    const deps = setupDeps({ prompter, runCrestodianChat });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ workspace: "/tmp/repair" }, runtime, deps);

    expect(runCrestodianChat).toHaveBeenCalledWith("/tmp/repair", runtime);
    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.activate).not.toHaveBeenCalled();
  });
});
