import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runDaemonRestart } from "../cli/daemon-cli/lifecycle.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import type { SystemAgentCommandDeps } from "./operations.js";
import type { SystemAgentOverview } from "./overview.js";
import { runSystemAgent, type RunSystemAgentOptions } from "./system-agent.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";
import { createSystemAgentVerifiedInferenceTestFixture } from "./system-agent.test-helpers.js";
import type { SystemAgentVerifiedInferenceBinding } from "./verified-inference.js";

const inferenceMocks = vi.hoisted(() => ({
  sharedVerifiedInference: undefined as SystemAgentVerifiedInferenceBinding | undefined,
}));
// mock-isolation: A rejected runner request must never reach the host daemon lifecycle.
vi.mock("../cli/daemon-cli/lifecycle.js", () => ({ runDaemonRestart: vi.fn() }));

vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
}));

vi.mock("./verified-inference.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./verified-inference.js")>();
  return {
    ...actual,
    resolveSystemAgentVerifiedInferenceRoute: (
      ...args: Parameters<typeof actual.resolveSystemAgentVerifiedInferenceRoute>
    ) => {
      // Ordinary runner cases share one immutable verified fixture. Distinct
      // bindings still use the real resolver for route and apply-boundary drift.
      if (args[0] === inferenceMocks.sharedVerifiedInference) {
        return Promise.resolve(args[0].execution);
      }
      return actual.resolveSystemAgentVerifiedInferenceRoute(...args);
    },
  };
});

const overview: SystemAgentOverview = {
  defaultAgentId: "main",
  defaultModel: "openai/gpt-5.5",
  agents: [],
  config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
  tools: {
    codex: { command: "codex", found: false, error: "not found" },
    claude: { command: "claude", found: false, error: "not found" },
    gemini: { command: "gemini", found: false, error: "not found" },
    apiKeys: { openai: true, anthropic: false },
  },
  gateway: { url: "ws://fixture", source: "test", reachable: false },
  references: { docsUrl: "https://docs.example", sourceUrl: "https://source.example" },
};

const systemAgentOverviewDeps = {
  formatOverview: () => "Default model: openai/gpt-5.5",
  loadOverview: async () => overview,
};

const verifiedConfig = {
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
      models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
    },
  },
} satisfies OpenClawConfig;
const changedConfig: OpenClawConfig = {
  agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
};

function configSnapshot(config: OpenClawConfig) {
  return {
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "h",
    config,
    runtimeConfig: config,
    sourceConfig: config,
    issues: [],
  };
}

let sharedFixture: Awaited<ReturnType<typeof createSystemAgentVerifiedInferenceTestFixture>>;

beforeAll(async () => {
  sharedFixture = await createSystemAgentVerifiedInferenceTestFixture(verifiedConfig);
  inferenceMocks.sharedVerifiedInference = sharedFixture.binding;
});

function createVerifiedRunOptions(deps: SystemAgentCommandDeps = {}, revalidate = false) {
  const fixture = sharedFixture;
  return {
    verifiedInference: revalidate ? { ...fixture.binding } : fixture.binding,
    deps: {
      readConfigFileSnapshot: vi.fn(async () => configSnapshot(verifiedConfig)) as never,
      ...deps,
    },
  };
}

function runner(runtime: RuntimeEnv, verified = createVerifiedRunOptions()) {
  return (options: Omit<RunSystemAgentOptions, "verifiedInference">, includeOverview = true) =>
    runSystemAgent(
      { ...verified, ...(includeOverview ? systemAgentOverviewDeps : {}), ...options },
      runtime,
    );
}

describe("runSystemAgent", () => {
  beforeEach(() => {
    vi.mocked(runDaemonRestart).mockReset().mockResolvedValue(true);
  });
  it("rejects a missing inference binding before any runner side effect", async () => {
    const { runtime } = createSystemAgentTestRuntime();
    const loadOverview = vi.fn(async () => overview);
    const planWithAssistant = vi.fn(async () => ({ command: "restart gateway" }));
    const runInteractiveTui = vi.fn(async () => {});
    const common = {
      deps: { loadOverview },
      planWithAssistant,
      runInteractiveTui,
      input: { isTTY: true } as unknown as NodeJS.ReadableStream,
      output: { isTTY: true } as unknown as NodeJS.WritableStream,
    };
    const withoutBinding = (opts: Omit<RunSystemAgentOptions, "verifiedInference">) =>
      opts as RunSystemAgentOptions;

    for (const options of [
      { json: true },
      { message: "please make things nicer" },
      { message: "restart gateway", yes: true },
      {},
    ]) {
      await expect(
        runSystemAgent(withoutBinding({ ...common, ...options }), runtime),
      ).rejects.toMatchObject({ message: expect.stringContaining("openclaw onboard") });
    }

    expect(loadOverview).not.toHaveBeenCalled();
    expect(planWithAssistant).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
    expect(runInteractiveTui).not.toHaveBeenCalled();
  });

  it("uses the assistant planner only to choose typed operations", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const onReady = vi.fn();
    await runner(runtime)({
      message: "the local bridge looks sleepy, poke it",
      onReady,
      planWithAssistant: async () => ({
        reply: "I can queue a Gateway restart.",
        command: "restart gateway",
        modelLabel: "openai/gpt-5.5",
      }),
    });

    expect(runDaemonRestart).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("[openclaw] planner: openai/gpt-5.5");
    expect(lines.join("\n")).toContain("[openclaw] interpreted: restart gateway");
    expect(lines.join("\n")).toContain("Plan: restart the Gateway. Say yes to apply.");
    expect(lines.indexOf("Default model: openai/gpt-5.5")).toBeLessThan(
      lines.findIndex((line) => line.includes("[openclaw] planner:")),
    );
  });

  it.each([
    "config set gateway.auth.token=very-secret",
    "config set gateway.auth.token=very-secret please",
    String.raw`config set gateway.auth.token\ very-secret please`,
    "config set-ref gateway.auth.tokenabcDEF123 env GATEWAY_TOKEN",
  ])(
    "keeps malformed config write %s away from the one-shot assistant planner",
    async (message) => {
      const { runtime, lines } = createSystemAgentTestRuntime();
      const planWithAssistant = vi.fn(async () => ({ command: "restart gateway" }));

      await runner(runtime)({
        message,
        planWithAssistant,
      });

      expect(planWithAssistant).not.toHaveBeenCalled();
      expect(lines.join("\n")).toContain("Invalid config path");
      expect(lines.join("\n")).not.toContain("very-secret");
      expect(lines.join("\n")).not.toContain("abcDEF123");
    },
  );

  it("rechecks one-shot authority at the persistent apply boundary", async () => {
    const { runtime } = createSystemAgentTestRuntime();
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce(configSnapshot(verifiedConfig))
      .mockResolvedValueOnce(configSnapshot(verifiedConfig))
      .mockResolvedValueOnce(configSnapshot(verifiedConfig))
      .mockResolvedValue(configSnapshot(changedConfig));
    const verified = createVerifiedRunOptions(
      {
        readConfigFileSnapshot: readConfigFileSnapshot as never,
      },
      true,
    );
    const run = runner(runtime, verified);

    await expect(
      run({
        message: "the bridge looks sleepy, restart it",
        yes: true,
        planWithAssistant: async () => ({ command: "restart gateway" }),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("verified inference route changed"),
    });

    expect(readConfigFileSnapshot).toHaveBeenCalledTimes(4);
    expect(runDaemonRestart).not.toHaveBeenCalled();
  });

  it("keeps exact one-shot parsing ahead of the assistant planner", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const planWithAssistant = vi.fn(async () => ({ command: "restart gateway" }));
    const onReady = vi.fn();
    await runner(runtime)({
      message: "models",
      planWithAssistant,
      onReady,
    });

    expect(planWithAssistant).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("Default model:");
  });

  it.each([
    { name: "no plan", plan: null },
    { name: "invalid command", plan: { command: "invent a new operation" } },
  ])("fails a fuzzy one-shot when inference returns $name", async ({ plan }) => {
    const { runtime } = createSystemAgentTestRuntime();
    await expect(
      runner(runtime)({
        message: "please make things nicer",
        planWithAssistant: async () => plan,
      }),
    ).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
  });

  it("prints a valid reply-only one-shot plan", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    await runner(runtime)({
      message: "explain the current setup",
      planWithAssistant: async () => ({ reply: "The current setup is healthy." }),
    });

    expect(lines).toEqual(["Default model: openai/gpt-5.5", "", "The current setup is healthy."]);
  });

  it("does not print a reply-only plan after its inference owner drifts", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    let currentConfig: OpenClawConfig = verifiedConfig;
    const verified = createVerifiedRunOptions(
      {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
      },
      true,
    );
    const run = runner(runtime, verified);

    await expect(
      run({
        message: "explain the current setup",
        planWithAssistant: async () => {
          currentConfig = changedConfig;
          return { reply: "stale reply" };
        },
      }),
    ).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
    expect(lines).not.toContain("stale reply");
  });

  it.each([true, false])("admits the TUI only with stdout TTY=%s", async (isTTY) => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runInteractiveTui = vi.fn(async () => {});
    const onReady = vi.fn();
    const run = runner(runtime)(
      {
        input: { isTTY: true } as unknown as NodeJS.ReadableStream,
        output: { isTTY } as unknown as NodeJS.WritableStream,
        ...(isTTY ? {} : { interactive: true }),
        runInteractiveTui,
        onReady,
      },
      false,
    );
    if (isTTY) {
      await run;
      expect(lines.join("\n")).not.toContain("Say: status");
    } else {
      await expect(run).rejects.toThrow("exit 1");
      expect(lines.join("\n")).toContain(
        "OpenClaw needs an interactive TTY. Use --message for one command.",
      );
    }
    expect(runInteractiveTui).toHaveBeenCalledTimes(isTTY ? 1 : 0);
    expect(onReady).toHaveBeenCalledTimes(isTTY ? 1 : 0);
  });

  it.each([{ message: "overview" }, { interactive: false }])(
    "prints the formatted overview exactly once for %j",
    async (options) => {
      const { runtime, lines } = createSystemAgentTestRuntime();
      const loadOverview = vi.fn(async () => overview);
      const runInteractiveTui = vi.fn(async () => {});
      await runner(runtime)(
        {
          ...options,
          loadOverview,
          formatOverview: () => "formatted overview",
          runInteractiveTui,
        },
        false,
      );

      expect(loadOverview).toHaveBeenCalledOnce();
      expect(runInteractiveTui).not.toHaveBeenCalled();
      expect(lines).toEqual(["formatted overview"]);
    },
  );
});
