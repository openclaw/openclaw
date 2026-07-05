// Crestodian TUI backend tests cover rescue status integration with the TUI backend.
import { describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
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

  it("catches a rejecting respond promise in sendChat and emits an error event", async () => {
    type ReplacableRespond = (runId: string, sessionKey: string, text: string) => Promise<void>;
    const backendWithEngine = await new Promise<{
      backend: {
        sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
        onEvent?: (evt: {
          event: string;
          payload?: { state?: string; errorMessage?: string };
        }) => void;
        engine: { handle: () => Promise<unknown>; dispose: () => Promise<void> };
        respond?: ReplacableRespond;
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
              engine: { handle: () => Promise<unknown>; dispose: () => Promise<void> };
              dispose: () => Promise<void>;
              respond: ReplacableRespond;
            };
            resolve({ backend, dispose: async () => backend.dispose() });
            return { exitReason: "exit" };
          },
        },
        createRuntime(),
      );
    });

    const { backend, dispose } = backendWithEngine;
    const events: Array<{ event: string; payload?: { state?: string; errorMessage?: string } }> =
      [];
    backend.onEvent = (evt) => events.push(evt);

    // Make the private respond() method itself reject. Current main would leave
    // this as an unhandled rejection because sendChat fires respond as void.
    backend.respond = async () => {
      throw new Error("simulated respond failure");
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await backend.sendChat({ message: "hello" });
      // Wait for the fire-and-forget catch handler to run.
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
    const errorEvent = events.find((e) => e.event === "chat" && e.payload?.state === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.payload?.errorMessage).toMatch(/simulated respond failure/);

    await dispose();
  });
});
