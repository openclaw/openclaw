// Crestodian TUI backend tests cover rescue status integration with the TUI backend.
import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { CrestodianInferenceUnavailableError } from "./inference-error.js";
import type { CrestodianOperation } from "./operations.js";
import type { CrestodianOverview } from "./overview.js";
import { runCrestodianTui } from "./tui-backend.js";

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

function createRuntime(): RuntimeEnv {
  return {
    log: () => undefined,
    error: () => undefined,
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
  };
}

describe("runCrestodianTui", () => {
  it("runs Crestodian inside the shared TUI shell", async () => {
    let runTuiCalls = 0;
    let runTuiOptions: unknown;

    await runCrestodianTui(
      {
        deps: {
          loadOverview: async () => overview,
        },
        runTui: async (opts) => {
          runTuiCalls += 1;
          runTuiOptions = opts;
          return { exitReason: "exit" };
        },
      },
      createRuntime(),
    );

    expect(runTuiCalls).toBe(1);
    const options = runTuiOptions as {
      local?: boolean;
      session?: string;
      historyLimit?: number;
      config?: unknown;
      title?: string;
      backend?: unknown;
    };
    expect(options.local).toBe(true);
    expect(options.session).toBe("agent:crestodian:main");
    expect(options.historyLimit).toBe(200);
    expect(options.config).toEqual({});
    expect(options.title).toBe("openclaw crestodian");
    if (!options.backend || typeof options.backend !== "object") {
      throw new Error("expected crestodian TUI backend");
    }
  });

  it("isolates event consumer failures during sendChat", async () => {
    const backendWithEngine = await new Promise<{
      backend: {
        sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
        onEvent?: (evt: {
          event: string;
          payload?: { state?: string; errorMessage?: string };
        }) => void;
        engine: {
          handle: () => Promise<{ text: string; action: "none" }>;
          dispose: () => Promise<void>;
        };
      };
      dispose: () => Promise<void>;
    }>((resolve) => {
      void runCrestodianTui(
        {
          deps: { loadOverview: async () => overview },
          runTui: async (opts) => {
            const backend = opts.backend as unknown as {
              sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
              onEvent?: (evt: {
                event: string;
                payload?: { state?: string; errorMessage?: string };
              }) => void;
              engine: {
                handle: () => Promise<{ text: string; action: "none" }>;
                dispose: () => Promise<void>;
              };
              dispose: () => Promise<void>;
            };
            resolve({ backend, dispose: async () => backend.dispose() });
            return { exitReason: "exit" };
          },
        },
        createRuntime(),
      );
    });

    const { backend, dispose } = backendWithEngine;
    backend.engine.handle = async () => ({ text: "hello", action: "none" });
    backend.onEvent = () => {
      throw new Error("simulated render failure");
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await backend.sendChat({ message: "hello" });
      // Wait for the fire-and-forget response path to emit its final event.
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await dispose();
    }

    expect(unhandled).toHaveLength(0);
  });

  it("emits an error without a fake final reply when inference fails", async () => {
    const events: Array<{ payload?: { state?: string; errorMessage?: string } }> = [];

    await runCrestodianTui(
      {
        deps: { loadOverview: async () => overview },
        runTui: async (opts) => {
          const backend = opts.backend as unknown as {
            sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
            onEvent?: (event: { payload?: { state?: string; errorMessage?: string } }) => void;
            engine: { handle: () => Promise<never> };
          };
          backend.engine.handle = async () => {
            throw new CrestodianInferenceUnavailableError("conversation");
          };
          backend.onEvent = (event) => events.push(event);

          await backend.sendChat({ message: "status please" });
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { exitReason: "exit" };
        },
      },
      createRuntime(),
    );

    expect(events).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          state: "error",
          errorMessage: expect.stringContaining("working inference"),
        }),
      }),
    ]);
  });

  it("retires the local session before a queued exact mutation can run", async () => {
    const handle = vi
      .fn()
      .mockRejectedValueOnce(new CrestodianInferenceUnavailableError("conversation"))
      .mockResolvedValue({ text: "mutation ran", action: "none" });
    const dispose = vi.fn(async () => undefined);
    const events: Array<{ payload?: { state?: string; errorMessage?: string } }> = [];

    await runCrestodianTui(
      {
        deps: { loadOverview: async () => overview },
        runTui: async (opts) => {
          const backend = opts.backend as unknown as {
            sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
            setRequestExitHandler: (handler: () => void) => void;
            onEvent?: (event: { payload?: { state?: string; errorMessage?: string } }) => void;
            engine: {
              handle: typeof handle;
              dispose: typeof dispose;
            };
          };
          backend.engine.handle = handle;
          backend.engine.dispose = dispose;
          backend.onEvent = (event) => events.push(event);

          const requestedExit = new Promise<void>((resolve) => {
            backend.setRequestExitHandler(resolve);
          });
          await backend.sendChat({ message: "status please" });
          await backend.sendChat({ message: "config set gateway.port 19001" });
          await requestedExit;
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { exitReason: "exit" };
        },
      },
      createRuntime(),
    );

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
    const cases: Array<{
      handoff: Extract<CrestodianOperation, { kind: "open-setup" }>;
      expected: string;
    }> = [
      {
        handoff: { kind: "open-setup", target: "channels", channel: "slack" },
        expected: "channels:slack:false",
      },
    ];

    for (const { handoff, expected } of cases) {
      const events: string[] = [];
      await runCrestodianTui(
        {
          deps: { loadOverview: async () => overview },
          setupWorkspace: "/tmp/custom-workspace",
          runTui: async (opts) => {
            const backend = opts.backend as unknown as {
              sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
              setRequestExitHandler: (handler: () => void) => void;
              engine: {
                handle: () => Promise<{
                  text: string;
                  action: "open-setup";
                  handoff: CrestodianOperation;
                }>;
                dispose: () => Promise<void>;
              };
            };
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
            await backend.sendChat({ message: "open setup wizard" });
            await requestedExit;
            return { exitReason: "exit" };
          },
          runChannelsAdd: async (opts, _runtime, params) => {
            events.push(`channels:${opts.channel ?? "all"}:${String(params?.hasFlags)}`);
          },
        },
        createRuntime(),
      );

      expect(events).toEqual(["disposed", expected]);
    }
  });
});
