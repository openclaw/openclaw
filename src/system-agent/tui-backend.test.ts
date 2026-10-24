// OpenClaw TUI backend tests cover rescue status integration with the TUI backend.
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import * as preparedModelCatalog from "../agents/prepared-model-catalog.js";
import { channelsAddCommand } from "../commands/channels/add.js";
import * as configModule from "../config/config.js";
import { createConfigFileSnapshot } from "../config/io.snapshot-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TuiBackend } from "../tui/tui-backend.js";
import type { SystemAgentChatEngine } from "./chat-engine.js";
import { runHostedGatewaySetup, runHostedSearchSetup } from "./hosted-setup.runtime.js";
import { createInferenceConfigFixture } from "./inference-config.test-support.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import type { SystemAgentCommandDeps, SystemAgentOperation } from "./operations.js";
import { createSystemAgentOverviewFixture } from "./overview.fixture.test-support.js";
import type { SystemAgentOverview } from "./overview.js";
import { createSystemAgentVerifiedInferenceTestFixture } from "./system-agent.test-helpers.js";
import { runSystemAgentTui, type SystemAgentTuiOptions } from "./tui-backend.js";
import { resolveSystemAgentVerifiedInferenceState } from "./verified-inference.js";

const verifiedInferenceMocks = vi.hoisted(() => ({
  preparedBindings: new WeakMap<object, OpenClawConfig>(),
}));

vi.mock("../commands/channels/add.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/channels/add.js")>()),
  channelsAddCommand: vi.fn(),
}));

vi.mock("./hosted-setup.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hosted-setup.runtime.js")>()),
  runHostedGatewaySetup: vi.fn(),
  runHostedSearchSetup: vi.fn(),
}));

vi.mock("../plugins/providers.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../plugins/providers.js")>();
  return {
    ...original,
    // The verified-inference helper replaces the registry snapshot with exact synthetic
    // records, so pass-through safety resolvers cannot consult the host plugin inventory.
    resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
    resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
  };
});

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  // These tests exercise the TUI boundary, not filesystem-backed catalog discovery.
  getPreparedModelCatalogSnapshot: vi.fn(() => undefined),
  readPreparedModelCatalog: vi.fn(async () => []),
}));

vi.mock("./verified-inference.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./verified-inference.js")>();
  return {
    ...original,
    resolveSystemAgentVerifiedInferenceState: vi.fn(async (binding) => {
      const config = verifiedInferenceMocks.preparedBindings.get(binding);
      return config
        ? { config, route: binding.execution }
        : await original.resolveSystemAgentVerifiedInferenceState(binding);
    }),
  };
});

const overview = createSystemAgentOverviewFixture({
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
});

const verifiedConfig = {
  agents: { defaults: { model: "openai/gpt-5.5" } },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        auth: "api-key",
        models: [],
      },
    },
  },
} satisfies OpenClawConfig;

function configSnapshot(config: OpenClawConfig) {
  return createConfigFileSnapshot({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "h",
    raw: null,
    parsed: config,
    runtimeConfig: config,
    sourceConfig: config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  });
}

let sharedVerifiedFixture: Awaited<
  ReturnType<typeof createSystemAgentVerifiedInferenceTestFixture>
>;

beforeAll(async () => {
  sharedVerifiedFixture = await createSystemAgentVerifiedInferenceTestFixture(verifiedConfig);
});

async function createVerifiedTuiOptions(
  deps: SystemAgentCommandDeps = {},
  config: OpenClawConfig = verifiedConfig,
  useRealVerification = false,
) {
  const fixture =
    config === verifiedConfig
      ? sharedVerifiedFixture
      : await createSystemAgentVerifiedInferenceTestFixture(config);
  if (!useRealVerification) {
    verifiedInferenceMocks.preparedBindings.set(fixture.binding, config);
  }
  const reader = vi
    .spyOn(configModule, "readConfigFileSnapshot")
    .mockResolvedValue(configSnapshot(config));
  onTestFinished(() => reader.mockRestore());
  return {
    verifiedInference: fixture.binding,
    deps,
  };
}

function createRuntime(): RuntimeEnv {
  return {
    log: () => undefined,
    error: () => undefined,
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
  };
}

type TestBackend = Omit<TuiBackend, "loadHistory" | "onEvent"> & {
  loadHistory: (opts: { sessionKey: string; limit?: number }) => Promise<{
    messages: Array<{ content: Array<{ text: string }> }>;
    thinkingLevel: string;
  }>;
  onEvent?: (event: { event: string; payload?: { state?: string; errorMessage?: string } }) => void;
  engine: Pick<SystemAgentChatEngine, "handle" | "dispose">;
  dispose: () => Promise<void>;
  setRequestExitHandler: (handler: () => void) => void;
};

async function withBackend(
  run: (backend: TestBackend) => Promise<void>,
  options?: SystemAgentTuiOptions,
  runtime = createRuntime(),
) {
  const verified =
    options ?? (await createVerifiedTuiOptions({ loadOverview: async () => overview }));
  await runSystemAgentTui(
    {
      ...verified,
      runTui: async ({ backend }) => {
        await run(backend as TestBackend);
        return { exitReason: "exit" };
      },
    },
    runtime,
  );
}

describe("runSystemAgentTui", () => {
  it("rejects a missing inference binding before overview, TUI, or setup", async () => {
    const loadOverview = vi.fn(async () => overview);
    const runTui = vi.fn(async () => ({ exitReason: "exit" as const }));
    const fixture = sharedVerifiedFixture;
    const options: SystemAgentTuiOptions = {
      verifiedInference: fixture.binding,
      deps: { loadOverview },
      runTui,
    };
    Reflect.deleteProperty(options, "verifiedInference");

    await expect(runSystemAgentTui(options, createRuntime())).rejects.toMatchObject({
      message: expect.stringContaining("openclaw onboard"),
    });

    expect(loadOverview).not.toHaveBeenCalled();
    expect(runTui).not.toHaveBeenCalled();
    expect(channelsAddCommand).not.toHaveBeenCalled();
  });

  it("reports a changed verified route without recommending onboarding", async () => {
    const verified = await createVerifiedTuiOptions();
    const runTui = vi.fn();
    vi.mocked(resolveSystemAgentVerifiedInferenceState).mockResolvedValueOnce(null);

    await expect(runSystemAgentTui({ ...verified, runTui }, createRuntime())).rejects.toMatchObject(
      {
        message: expect.stringContaining("verified inference route changed"),
      },
    );
    expect(runTui).not.toHaveBeenCalled();
  });

  it("runs OpenClaw inside the shared TUI shell", async () => {
    const verified = await createVerifiedTuiOptions(
      { loadOverview: async () => overview },
      verifiedConfig,
      true,
    );
    const resolveVerifiedState = vi.mocked(resolveSystemAgentVerifiedInferenceState);
    resolveVerifiedState.mockClear();
    const runTui = vi.fn(
      async (opts: Parameters<NonNullable<SystemAgentTuiOptions["runTui"]>>[0]) => {
        if (!opts.backend) {
          throw new Error("Expected the system-agent TUI backend");
        }
        for (const sessionKey of ["agent:openclaw:main", "main"]) {
          await expect(opts.backend.describeSession({ sessionKey })).resolves.toMatchObject({
            session: { key: "agent:openclaw:main", model: "gpt-5.5", modelProvider: "openai" },
            defaults: { model: "gpt-5.5", modelProvider: "openai" },
          });
        }
        await expect(
          opts.backend.describeSession({ sessionKey: "agent:openclaw:missing" }),
        ).resolves.toMatchObject({ session: null });
        return { exitReason: "exit" as const };
      },
    );

    await runSystemAgentTui({ ...verified, runTui }, createRuntime());

    expect(runTui).toHaveBeenCalledOnce();
    expect(resolveVerifiedState).toHaveBeenCalledOnce();
    expect(resolveVerifiedState).toHaveBeenCalledWith(verified.verifiedInference);
    const [resolveOrder] = resolveVerifiedState.mock.invocationCallOrder;
    const [runTuiOrder] = runTui.mock.invocationCallOrder;
    if (resolveOrder === undefined || runTuiOrder === undefined) {
      throw new Error("expected verified route resolution before TUI startup");
    }
    expect(resolveOrder).toBeLessThan(runTuiOrder);
    expect(runTui.mock.calls[0]?.[0]).toMatchObject({
      local: true,
      session: "agent:openclaw:main",
      historyLimit: 200,
      config: {},
      title: "openclaw setup",
      backend: expect.any(Object),
    });
    expect(runTui.mock.calls[0]?.[0].config).toEqual({});
  }, 240_000);

  it("retains and returns only the requested latest history", async () => {
    await withBackend(async (backend) => {
      backend.engine.handle = () => new Promise(() => {});
      backend.engine.dispose = async () => undefined;

      for (let index = 1; index <= 201; index += 1) {
        await backend.sendChat({
          sessionKey: "agent:openclaw:main",
          message: `message-${index}`,
        });
      }

      const retained = await backend.loadHistory({
        sessionKey: "agent:openclaw:main",
        limit: 500,
      });
      expect(retained.messages).toHaveLength(200);
      expect(retained.messages[0]?.content[0]?.text).toBe("message-2");

      const tail = await backend.loadHistory({
        sessionKey: "agent:openclaw:main",
        limit: 2,
      });
      expect(tail.messages.map((entry) => entry.content[0]?.text)).toEqual([
        "message-200",
        "message-201",
      ]);
    });
  });

  it("opens the verified setup shell without preparing an unpublished model catalog", async () => {
    const verified = await createVerifiedTuiOptions({ loadOverview: async () => overview });
    const catalogPreparation = vi.mocked(preparedModelCatalog.readPreparedModelCatalog);
    const publishedSnapshot = vi
      .spyOn(preparedModelCatalog, "getPreparedModelCatalogSnapshot")
      .mockReturnValue(undefined);
    const runTui = vi.fn(async () => ({ exitReason: "exit" as const }));

    catalogPreparation.mockClear();
    catalogPreparation.mockRejectedValueOnce(new Error("catalog preparation must not block setup"));

    try {
      await runSystemAgentTui({ ...verified, runTui }, createRuntime());

      expect(publishedSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ config: verifiedConfig, readOnly: true }),
      );
      expect(catalogPreparation).not.toHaveBeenCalled();
      expect(runTui).toHaveBeenCalledOnce();
      expect(runTui).toHaveBeenCalledWith(
        expect.objectContaining({
          local: true,
          session: "agent:openclaw:main",
          title: "openclaw setup",
        }),
      );
    } finally {
      publishedSnapshot.mockRestore();
      catalogPreparation.mockReset();
      catalogPreparation.mockResolvedValue([]);
    }
  });

  it("reports the verified model without its auth profile and the effective thinking level", async () => {
    const config = {
      ...verifiedConfig,
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          thinkingDefault: "high",
        },
      },
    } satisfies OpenClawConfig;
    const profileQualifiedOverview = {
      ...overview,
      defaultModel: "openai/gpt-5.5@openai:setup-test",
    } satisfies SystemAgentOverview;
    const verified = await createVerifiedTuiOptions(
      { loadOverview: async () => profileQualifiedOverview },
      config,
    );

    await withBackend(async (backend) => {
      await expect(
        backend.loadHistory({ sessionKey: "agent:openclaw:main" }),
      ).resolves.toMatchObject({ thinkingLevel: "high" });
      await expect(backend.listSessions()).resolves.toMatchObject({
        sessions: [
          {
            model: "gpt-5.5",
            modelProvider: "openai",
            thinkingLevel: "high",
          },
        ],
      });
    }, verified);
  });

  it("reports that /model cannot replace the active verified inference route", async () => {
    await withBackend(async (backend) => {
      await expect(
        backend.patchSession({
          key: "agent:openclaw:main",
          model: "anthropic/claude-opus-4-8",
        }),
      ).rejects.toThrow("cannot change the model inside its active verified session");
      await expect(backend.listSessions()).resolves.toMatchObject({
        sessions: [{ model: "gpt-5.5", modelProvider: "openai" }],
      });
    });
  });

  it("isolates event consumer failures during sendChat", async () => {
    await withBackend(async (backend) => {
      backend.engine.handle = async () => ({ text: "hello", action: "none" });
      backend.onEvent = () => {
        throw new Error("simulated render failure");
      };
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        await backend.sendChat({ sessionKey: "agent:openclaw:main", message: "hello" });
        // Wait for the fire-and-forget response path to emit its final event.
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
      expect(unhandled).toHaveLength(0);
    });
  });

  it("retires the local session before a queued exact mutation can run", async () => {
    const handle = vi
      .fn()
      .mockRejectedValueOnce(new SystemAgentInferenceUnavailableError("conversation"))
      .mockResolvedValue({ text: "mutation ran", action: "none" });
    const dispose = vi.fn(async () => undefined);
    const events: Array<{ payload?: { state?: string; errorMessage?: string } }> = [];
    await withBackend(async (backend) => {
      backend.engine.handle = handle;
      backend.engine.dispose = dispose;
      backend.onEvent = (event) => events.push(event);

      const requestedExit = new Promise<void>((resolve) => {
        backend.setRequestExitHandler(resolve);
      });
      await backend.sendChat({ sessionKey: "agent:openclaw:main", message: "status please" });
      await backend.sendChat({
        sessionKey: "agent:openclaw:main",
        message: "config set gateway.port 19001",
      });
      await requestedExit;
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });

    expect(handle).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            state: "error",
            errorMessage: expect.stringContaining("working inference"),
          }),
        }),
      ]),
    );
    expect(events.some((event) => event.payload?.state === "final")).toBe(false);
  });

  it("launches setup handoffs after the chat TUI is disposed", async () => {
    const cases: Array<[Extract<SystemAgentOperation, { kind: "open-setup" }>, string]> = [
      [
        { kind: "open-setup", target: "channels", channel: "slack" },
        "channels:slack:false:function",
      ],
      [{ kind: "open-setup", target: "search" }, "search:function"],
      [{ kind: "open-setup", target: "gateway" }, "gateway:guarded"],
    ];

    for (const [handoff, expected] of cases) {
      const events: string[] = [];
      vi.mocked(channelsAddCommand).mockImplementation(async (opts, _runtime, params) => {
        events.push(
          `channels:${opts.channel ?? "all"}:${String(params?.hasFlags)}:${typeof params?.beforePersistentEffect}`,
        );
      });
      vi.mocked(runHostedSearchSetup).mockImplementation(
        async (_prompter, beforePersistentEffect) => {
          events.push(`search:${typeof beforePersistentEffect}`);
          return "applied";
        },
      );
      vi.mocked(runHostedGatewaySetup).mockImplementation(
        async (_prompter, beforePersistentEffect) => {
          await beforePersistentEffect(runtime);
          events.push("gateway:guarded");
          return "applied";
        },
      );
      const runtime = createRuntime();
      runtime.log = (...args) => events.push(`log:${args.join(" ")}`);
      let verified = await createVerifiedTuiOptions({ loadOverview: async () => overview });
      if (handoff.target === "gateway") {
        const configFixture = await createInferenceConfigFixture(verifiedConfig);
        const snapshot = configFixture.snapshot;
        const fixture = await createSystemAgentVerifiedInferenceTestFixture(
          snapshot.runtimeConfig ?? snapshot.config,
          snapshot,
        );
        verified = {
          verifiedInference: fixture.binding,
          deps: { loadOverview: async () => overview },
        };
        const reader = vi
          .spyOn(configModule, "readConfigFileSnapshot")
          .mockImplementation(configFixture.read);
        onTestFinished(() => reader.mockRestore());
      }
      await withBackend(
        async (backend) => {
          backend.engine.handle = async () => ({
            text: "Opening setup.",
            action: "open-setup",
            handoff,
          });
          backend.engine.dispose = async () => {
            events.push("disposed");
          };
          const requestedExit = new Promise<void>((resolve) => {
            backend.setRequestExitHandler(resolve);
          });
          await backend.sendChat({
            sessionKey: "agent:openclaw:main",
            message: "open setup wizard",
          });
          await requestedExit;
        },
        { ...verified, setupWorkspace: "/tmp/custom-workspace" },
        runtime,
      );

      expect(events).toEqual([
        "disposed",
        expected,
        ...(handoff.target === "gateway"
          ? ["log:Done — gateway settings saved. Run `openclaw gateway restart` to apply them."]
          : []),
      ]);
    }
  });
});
