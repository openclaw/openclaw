import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveSessionStoreTargetsOrExit: vi.fn(),
  loadSessionStore: vi.fn(),
  updateSessionStore: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("./session-store-targets.js", () => ({
  resolveSessionStoreTargetsOrExit: mocks.resolveSessionStoreTargetsOrExit,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => ({
    confirm: mocks.confirm,
  }),
}));

import { sessionsSwitchModelCommand } from "./sessions-switch-model.js";

function makeRuntime(): { runtime: RuntimeEnv; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    runtime: {
      log: (message: unknown) => logs.push(String(message)),
      error: (message: unknown) => errors.push(String(message)),
      exit: (code: number) => {
        throw new Error(`exit ${code}`);
      },
    },
    logs,
    errors,
  };
}

describe("sessionsSwitchModelCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: "venice/minimax-m25",
          models: {
            "venice/minimax-m25": {},
            "venice/kimi-k2-5": {},
          },
        },
      },
    });
    mocks.resolveSessionStoreTargetsOrExit.mockReturnValue([
      { agentId: "main", storePath: "/tmp/sessions-main.json" },
    ]);
    mocks.confirm.mockResolvedValue(true);
    mocks.updateSessionStore.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, SessionEntry>) => Promise<void> | void,
      ) => {
        const store = {
          "agent:main:slack:channel:a": {
            sessionId: "one",
            updatedAt: 1,
            modelProvider: "venice",
            model: "kimi-k2-5",
            groupChannel: "#bots",
          },
        } satisfies Record<string, SessionEntry>;
        await mutator(store);
      },
    );
  });

  it("requires exactly one filter", async () => {
    const { runtime, errors } = makeRuntime();

    await expect(
      sessionsSwitchModelCommand(
        {
          providerModel: "venice/minimax-m25",
          yes: true,
        },
        runtime,
      ),
    ).rejects.toThrow("exit 1");

    expect(errors[0]).toContain("Specify exactly one filter");
  });

  it("rejects models that are absent from models list plain set", async () => {
    const { runtime, errors } = makeRuntime();

    await expect(
      sessionsSwitchModelCommand(
        {
          providerModel: "venice/unknown-model",
          all: true,
          yes: true,
        },
        runtime,
      ),
    ).rejects.toThrow("exit 1");

    expect(errors[0]).toContain('not found in "openclaw models list --plain"');
  });

  it("supports --slack-channel matching with optional leading # and dry-run", async () => {
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:slack:channel:a": {
        sessionId: "one",
        updatedAt: 1,
        modelProvider: "venice",
        model: "kimi-k2-5",
        groupChannel: "#BoTs",
      },
      "agent:main:slack:channel:b": {
        sessionId: "two",
        updatedAt: 2,
        modelProvider: "venice",
        model: "kimi-k2-5",
        groupChannel: "#ops",
      },
    } satisfies Record<string, SessionEntry>);

    const { runtime, logs } = makeRuntime();
    await sessionsSwitchModelCommand(
      {
        providerModel: "venice/minimax-m25",
        slackChannel: "bots",
        dryRun: true,
        yes: true,
      },
      runtime,
    );

    expect(logs.some((line) => line.includes("[DRY RUN] Switching 1 session(s)"))).toBe(true);
    expect(logs.some((line) => line.includes("agent:main:slack:channel:a"))).toBe(true);
    expect(logs.some((line) => line.includes("1 session(s) will be updated."))).toBe(true);
    expect(logs.some((line) => line.includes("Dry run - no changes applied."))).toBe(true);
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
  });

  it("updates matching sessions when confirmed", async () => {
    const startStore = {
      "agent:main:slack:channel:a": {
        sessionId: "one",
        updatedAt: 1,
        modelProvider: "venice",
        model: "kimi-k2-5",
      },
      "agent:main:slack:channel:b": {
        sessionId: "two",
        updatedAt: 2,
        modelProvider: "venice",
        model: "minimax-m25",
      },
    } satisfies Record<string, SessionEntry>;
    mocks.loadSessionStore.mockReturnValue(startStore);

    let mutated: Record<string, SessionEntry> = {};
    mocks.updateSessionStore.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, SessionEntry>) => Promise<void> | void,
      ) => {
        mutated = structuredClone(startStore);
        await mutator(mutated);
      },
    );

    const { runtime, logs } = makeRuntime();
    await sessionsSwitchModelCommand(
      {
        providerModel: "venice/minimax-m25",
        all: true,
        yes: true,
      },
      runtime,
    );

    expect(mocks.updateSessionStore).toHaveBeenCalledTimes(1);
    expect(mutated["agent:main:slack:channel:a"]?.model).toBe("minimax-m25");
    expect(mutated["agent:main:slack:channel:a"]?.modelProvider).toBe("venice");
    expect(mutated["agent:main:slack:channel:b"]?.model).toBe("minimax-m25");
    expect(logs.some((line) => line.includes("Done - updated 1 session(s)."))).toBe(true);
  });
});
