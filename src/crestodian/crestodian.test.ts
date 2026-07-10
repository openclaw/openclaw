// Crestodian tests cover main rescue and audit command behavior.
import { describe, expect, it } from "vitest";
import { runCrestodian } from "./crestodian.js";
import { createCrestodianTestRuntime } from "./crestodian.test-helpers.js";
import { CrestodianInferenceUnavailableError } from "./inference-error.js";
import type { CrestodianOverview } from "./overview.js";

const overview: CrestodianOverview = {
  defaultAgentId: "main",
  defaultModel: "openai/gpt-5.5",
  agents: [{ id: "main", isDefault: true, model: "openai/gpt-5.5" }],
  config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
  tools: {
    codex: { command: "codex", found: false, error: "not found" },
    claude: { command: "claude", found: false, error: "not found" },
    gemini: { command: "gemini", found: false, error: "not found" },
    apiKeys: { openai: true, anthropic: false },
  },
  gateway: {
    url: "ws://127.0.0.1:18789",
    source: "local loopback",
    reachable: false,
    error: "offline",
  },
  references: {
    docsUrl: "https://docs.openclaw.ai",
    sourceUrl: "https://github.com/openclaw/openclaw",
  },
};

const crestodianOverviewDeps = {
  formatOverview: () => "Default model: openai/gpt-5.5",
  loadOverview: async () => overview,
};

describe("runCrestodian", () => {
  it("uses the assistant planner only to choose typed operations", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    let runGatewayRestartCalls = 0;
    let onReadyCalls = 0;

    await runCrestodian(
      {
        message: "the local bridge looks sleepy, poke it",
        deps: {
          runGatewayRestart: async () => {
            runGatewayRestartCalls += 1;
          },
        },
        onReady: () => {
          onReadyCalls += 1;
        },
        planWithAssistant: async () => ({
          reply: "I can queue a Gateway restart.",
          command: "restart gateway",
          modelLabel: "openai/gpt-5.5",
        }),
        ...crestodianOverviewDeps,
      },
      runtime,
    );

    expect(runGatewayRestartCalls).toBe(0);
    expect(onReadyCalls).toBe(0);
    expect(lines.join("\n")).toContain("[crestodian] planner: openai/gpt-5.5");
    expect(lines.join("\n")).toContain("[crestodian] interpreted: restart gateway");
    expect(lines.join("\n")).toContain("Plan: restart the Gateway. Say yes to apply.");
    expect(lines.indexOf("Default model: openai/gpt-5.5")).toBeLessThan(
      lines.findIndex((line) => line.includes("[crestodian] planner:")),
    );
  });

  it("keeps exact one-shot parsing ahead of the assistant planner", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    let plannerCalls = 0;
    let onReadyCalls = 0;

    await runCrestodian(
      {
        message: "models",
        planWithAssistant: async () => {
          plannerCalls += 1;
          return { command: "restart gateway" };
        },
        onReady: () => {
          onReadyCalls += 1;
        },
        ...crestodianOverviewDeps,
      },
      runtime,
    );

    expect(plannerCalls).toBe(0);
    expect(onReadyCalls).toBe(0);
    expect(lines.join("\n")).toContain("Default model:");
  });

  it("prints an explicit one-shot overview exactly once", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();

    await runCrestodian(
      {
        message: "overview",
        formatOverview: () => "formatted overview",
        loadOverview: async () => overview,
      },
      runtime,
    );

    expect(lines).toEqual(["formatted overview"]);
  });

  it.each([
    { name: "no plan", plan: null },
    { name: "invalid command", plan: { command: "invent a new operation" } },
  ])("fails a fuzzy one-shot when inference returns $name", async ({ plan }) => {
    const { runtime } = createCrestodianTestRuntime();

    await expect(
      runCrestodian(
        {
          message: "please make things nicer",
          planWithAssistant: async () => plan,
          ...crestodianOverviewDeps,
        },
        runtime,
      ),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);
  });

  it("prints a valid reply-only one-shot plan", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();

    await runCrestodian(
      {
        message: "explain the current setup",
        planWithAssistant: async () => ({ reply: "The current setup is healthy." }),
        ...crestodianOverviewDeps,
      },
      runtime,
    );

    expect(lines).toEqual(["Default model: openai/gpt-5.5", "", "The current setup is healthy."]);
  });

  it("starts interactive Crestodian in the TUI shell", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    let runInteractiveTuiCalls = 0;
    let onReadyCalls = 0;

    await runCrestodian(
      {
        input: { isTTY: true } as unknown as NodeJS.ReadableStream,
        output: { isTTY: true } as unknown as NodeJS.WritableStream,
        runInteractiveTui: async () => {
          runInteractiveTuiCalls += 1;
        },
        onReady: () => {
          onReadyCalls += 1;
        },
      },
      runtime,
    );

    expect(runInteractiveTuiCalls).toBe(1);
    expect(onReadyCalls).toBe(1);
    expect(lines.join("\n")).not.toContain("Say: status");
  });

  it("prints the formatted overview exactly once when interactive mode is disabled", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    let loadOverviewCalls = 0;
    let runInteractiveTuiCalls = 0;

    await runCrestodian(
      {
        interactive: false,
        loadOverview: async () => {
          loadOverviewCalls += 1;
          return overview;
        },
        formatOverview: () => "formatted overview",
        runInteractiveTui: async () => {
          runInteractiveTuiCalls += 1;
        },
      },
      runtime,
    );

    expect(loadOverviewCalls).toBe(1);
    expect(runInteractiveTuiCalls).toBe(0);
    expect(lines).toEqual(["formatted overview"]);
  });

  it.each([
    {
      name: "stdin is not a TTY",
      input: { isTTY: false } as unknown as NodeJS.ReadableStream,
      output: { isTTY: true } as unknown as NodeJS.WritableStream,
      interactive: true,
    },
    {
      name: "stdout is not a TTY",
      input: { isTTY: true } as unknown as NodeJS.ReadableStream,
      output: { isTTY: false } as unknown as NodeJS.WritableStream,
      interactive: true,
    },
  ])("exits non-zero when $name", async ({ input, output, interactive }) => {
    const { runtime, lines } = createCrestodianTestRuntime();
    let runInteractiveTuiCalls = 0;

    await expect(
      runCrestodian(
        {
          input,
          output,
          interactive,
          runInteractiveTui: async () => {
            runInteractiveTuiCalls += 1;
          },
        },
        runtime,
      ),
    ).rejects.toThrow("exit 1");

    expect(runInteractiveTuiCalls).toBe(0);
    expect(lines.join("\n")).toContain(
      "Crestodian needs an interactive TTY. Use --message for one command.",
    );
  });
});
