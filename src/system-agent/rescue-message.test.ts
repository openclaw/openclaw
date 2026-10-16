import assert from "node:assert/strict";
// OpenClaw rescue message tests cover generated rescue message content.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createAgent } from "../agents/agent-create.js";
import type { CommandContext } from "../auto-reply/reply/commands-types.js";
import { runDaemonRestart, runDaemonStart, runDaemonStop } from "../cli/daemon-cli/lifecycle.js";
import { runPluginsListCommand } from "../cli/plugins-list-command.js";
import { runPluginsSearchCommand } from "../cli/plugins-search-command.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createCorePluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runTui } from "../tui/tui.js";
import { listSystemAgentAuditEntriesForTests } from "./audit.test-support.js";
import { extractSystemAgentRescueMessage, runSystemAgentRescueMessage } from "./rescue-message.js";
import { verifySetupInferenceConfig } from "./setup-inference.js";

let tempRoot = "";
let tempDirId = 0;

type TestConfig = Record<string, unknown>;

function readLastAuditEntry(): Record<string, unknown> {
  return (listSystemAgentAuditEntriesForTests().at(-1)?.value ?? {}) as Record<string, unknown>;
}

const runPluginInstallCommandMock = vi.hoisted(() => vi.fn(async () => undefined));
// mock-isolation: Keep agent creation and its persistent stores outside rescue approval proof.
vi.mock("../agents/agent-create.js", () => ({ createAgent: vi.fn() }));
// mock-isolation: Rescue approval must not manipulate the machine's daemon lifecycle.
vi.mock("../cli/daemon-cli/lifecycle.js", () => ({
  runDaemonRestart: vi.fn(),
  runDaemonStart: vi.fn(),
  runDaemonStop: vi.fn(),
}));
// mock-isolation: Supply external plugin-list output without loading the host CLI registry.
vi.mock("../cli/plugins-list-command.js", () => ({ runPluginsListCommand: vi.fn() }));
// mock-isolation: Supply external plugin-search output without loading the host CLI registry.
vi.mock("../cli/plugins-search-command.js", () => ({ runPluginsSearchCommand: vi.fn() }));
// mock-isolation: Remote rescue must never initialize the local terminal UI.
vi.mock("../tui/tui.js", () => ({ runTui: vi.fn() }));
// mock-isolation: Keep live provider inference outside conversational approval proof.
vi.mock("./setup-inference.js", () => ({ verifySetupInferenceConfig: vi.fn() }));

const mockConfig = vi.hoisted(() => {
  const state = {
    path: "/tmp/openclaw.json",
    config: {} as TestConfig,
    hash: "mock-hash-0" as string | undefined,
  };
  const cloneConfig = () => structuredClone(state.config);
  const snapshot = () => {
    const config = cloneConfig();
    return {
      path: state.path,
      exists: true,
      raw: `${JSON.stringify(config)}\n`,
      parsed: config,
      sourceConfig: config,
      resolved: config,
      valid: true,
      runtimeConfig: config,
      config,
      hash: state.hash,
      issues: [],
      warnings: [],
      legacyIssues: [],
    };
  };
  return {
    reset() {
      state.path = "/tmp/openclaw.json";
      state.config = {};
      state.hash = "mock-hash-0";
    },
    currentConfig() {
      return cloneConfig();
    },
    readConfigFileSnapshot: vi.fn(async () => snapshot()),
    mutateConfigFile: vi.fn(
      async (params: {
        mutate: (
          draft: TestConfig,
          context: { snapshot: ReturnType<typeof snapshot> },
        ) => Promise<void> | void;
      }) => {
        const before = snapshot();
        const draft = cloneConfig();
        await params.mutate(draft, { snapshot: before });
        state.config = draft;
        state.hash = "mock-hash-1";
        return {
          path: state.path,
          previousHash: before.hash ?? null,
          persistedHash: before.hash ?? null,
          snapshot: before,
          nextConfig: cloneConfig(),
          result: undefined,
        };
      },
    ),
  };
});

vi.mock("../cli/plugins-install-command.js", () => ({
  runPluginInstallCommand: runPluginInstallCommandMock,
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    clearConfigCache: vi.fn(),
    mutateConfigFile: mockConfig.mutateConfigFile,
    readConfigFileSnapshot: mockConfig.readConfigFileSnapshot,
  };
});

vi.mock("../commands/models/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/models/shared.js")>();
  return {
    ...actual,
    applyDefaultModelPrimaryUpdate: ({
      cfg,
      modelRaw,
      field,
    }: {
      cfg: TestConfig;
      modelRaw: string;
      field: "model" | "imageModel";
    }) => ({
      ...cfg,
      agents: {
        ...(cfg.agents as TestConfig | undefined),
        defaults: {
          ...(cfg.agents as { defaults?: TestConfig } | undefined)?.defaults,
          [field]: { primary: modelRaw },
        },
      },
    }),
  };
});

vi.mock("../config/model-input.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/model-input.js")>();
  return {
    ...actual,
    resolveAgentModelPrimaryValue: (model?: string | { primary?: string }) =>
      typeof model === "string" ? model : model?.primary,
  };
});

async function makeStateDir(prefix: string): Promise<string> {
  const dir = path.join(tempRoot, `${prefix}${tempDirId++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function withRescueStateDir(
  prefix: string,
  run: (stateDir: string) => Promise<void>,
): Promise<void> {
  const stateDir = await makeStateDir(prefix);
  resetPluginStateStoreForTests();
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    try {
      await run(stateDir);
    } finally {
      vi.useRealTimers();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
    }
  });
}

function commandContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    surface: "whatsapp",
    channel: "whatsapp",
    channelId: "whatsapp",
    accountId: "default",
    ownerList: ["user:owner"],
    senderIsOwner: true,
    isAuthorizedSender: true,
    senderId: "user:owner",
    rawBodyNormalized: "/openclaw models",
    commandBodyNormalized: "/openclaw models",
    from: "user:owner",
    to: "account:default",
    ...overrides,
  };
}

function openRescuePendingTestStore() {
  return createCorePluginStateSyncKeyedStore<unknown>({
    ownerId: "core:system-agent",
    namespace: "rescue-pending",
    maxEntries: 1_024,
    overflowPolicy: "reject-new",
  });
}

function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }, label: string): T[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

async function runRescue(commandBody: string, cfg: OpenClawConfig, ctx = commandContext()) {
  return await runSystemAgentRescueMessage({
    cfg,
    command: { ...ctx, commandBodyNormalized: commandBody },
    commandBody,
    isGroup: false,
  });
}

describe("OpenClaw rescue message", () => {
  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "system-agent-rescue-"));
  });

  beforeEach(() => {
    mockConfig.reset();
    runPluginInstallCommandMock.mockClear();
    vi.mocked(runDaemonRestart).mockReset().mockResolvedValue(true);
    vi.mocked(runDaemonStart).mockReset().mockResolvedValue(undefined);
    vi.mocked(runDaemonStop).mockReset().mockResolvedValue(undefined);
    vi.mocked(createAgent).mockReset();
    vi.mocked(runTui).mockReset();
    vi.mocked(runPluginsListCommand).mockReset();
    vi.mocked(runPluginsSearchCommand).mockReset();
    vi.mocked(verifySetupInferenceConfig).mockReset();
  });

  afterAll(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPluginStateStoreForTests();
  });

  it("recognizes the OpenClaw rescue command", () => {
    expect(extractSystemAgentRescueMessage("/openclaw status")).toBe("status");
    expect(extractSystemAgentRescueMessage("/openclaw")).toBe("");
    expect(extractSystemAgentRescueMessage("/status")).toBeNull();
  });

  it("denies rescue when sandboxing is active", async () => {
    await expect(
      runRescue("/openclaw status", {
        agents: { defaults: { sandbox: { mode: "all" } } },
      }),
    ).resolves.toContain("sandboxing is active");
  });

  it("refuses TUI handoff from remote rescue", async () => {
    const cfg: OpenClawConfig = {};

    await expect(runRescue("/openclaw talk to agent", cfg, commandContext())).resolves.toContain(
      "cannot open the local TUI",
    );
    await expect(runRescue("/openclaw chat", cfg, commandContext())).resolves.toContain(
      "cannot open the local TUI",
    );
    expect(runTui).not.toHaveBeenCalled();
  });

  it("rejects natural language instead of guessing an operation", async () => {
    const cfg: OpenClawConfig = {};

    // Questions must never become mutation plans (previously "why did my
    // gateway stop" keyword-matched into a gateway-stop proposal).
    await expect(
      runRescue("/openclaw why did my gateway stop", cfg, commandContext()),
    ).resolves.toContain("I can run doctor/status/health");
    await expect(
      runRescue("/openclaw explain how restart gateway works", cfg, commandContext()),
    ).resolves.toContain("I can run doctor/status/health");
    expect(runDaemonStop).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
  });

  it("refuses channel setup from remote rescue with a local pointer", async () => {
    const cfg: OpenClawConfig = {};
    await expect(runRescue("/openclaw connect telegram", cfg)).resolves.toContain(
      "cannot host the interactive channel setup",
    );
  });

  it("refuses doctor repairs without creating a pending approval", async () => {
    await withRescueStateDir("doctor-fix-refused-", async () => {
      const cfg: OpenClawConfig = {};

      const reply = await runRescue("/openclaw doctor fix", cfg, commandContext());
      expect(reply).toContain("machine running OpenClaw");
      expect(reply).toContain("with OpenClaw stopped");
      expect(reply).toContain("run `openclaw doctor --fix`");
      await expect(runRescue("/openclaw yes", cfg, commandContext())).resolves.toBe(
        "No pending OpenClaw rescue change is waiting for approval.",
      );
    });
  });

  it("refuses config deletion without creating a pending approval or writing config", async () => {
    await withRescueStateDir("config-unset-refused-", async () => {
      const cfg: OpenClawConfig = {};
      const before = mockConfig.currentConfig();
      mockConfig.mutateConfigFile.mockClear();

      await expect(
        runRescue("/openclaw config unset agents.defaults.fastModeDefault", cfg),
      ).resolves.toContain("cannot remove configuration settings");
      await expect(runRescue("/openclaw yes", cfg)).resolves.toBe(
        "No pending OpenClaw rescue change is waiting for approval.",
      );
      expect(mockConfig.mutateConfigFile).not.toHaveBeenCalled();
      expect(mockConfig.currentConfig()).toEqual(before);
      expect(listSystemAgentAuditEntriesForTests()).toEqual([]);
    });
  });

  it("drops a pending rescue change on decline", async () => {
    await withRescueStateDir("decline-", async () => {
      const cfg: OpenClawConfig = {};

      await expect(
        runRescue("/openclaw restart gateway", cfg, commandContext()),
      ).resolves.toContain("Reply /openclaw yes to apply");
      await expect(runRescue("/openclaw no", cfg, commandContext())).resolves.toContain(
        "Dropped the pending OpenClaw rescue change",
      );
      await expect(runRescue("/openclaw yes", cfg, commandContext())).resolves.toBe(
        "No pending OpenClaw rescue change is waiting for approval.",
      );
      expect(runDaemonRestart).not.toHaveBeenCalled();
    });
  });

  it("revokes a pending write when a fresh read-only command arrives", async () => {
    await withRescueStateDir("read-revokes-", async () => {
      const cfg: OpenClawConfig = {};
      vi.mocked(runPluginsListCommand).mockImplementation(async (_opts, runtime) =>
        runtime?.log("plugin rows"),
      );

      await expect(
        runRescue("/openclaw restart gateway", cfg, commandContext()),
      ).resolves.toContain("Reply /openclaw yes to apply");
      await expect(runRescue("/openclaw plugins list", cfg, commandContext())).resolves.toBe(
        "plugin rows",
      );
      await expect(runRescue("/openclaw yes", cfg, commandContext())).resolves.toBe(
        "No pending OpenClaw rescue change is waiting for approval.",
      );
      expect(runDaemonRestart).not.toHaveBeenCalled();
    });
  });

  it("consumes a pending approval at most once under concurrent approvals", async () => {
    await withRescueStateDir("concurrent-approve-", async () => {
      const cfg: OpenClawConfig = {};

      await runRescue("/openclaw restart gateway", cfg, commandContext());
      const replies = await Promise.all([
        runRescue("/openclaw yes", cfg, commandContext()),
        runRescue("/openclaw yes", cfg, commandContext()),
      ]);

      expect(runDaemonRestart).toHaveBeenCalledTimes(1);
      expect(replies).toContain("No pending OpenClaw rescue change is waiting for approval.");
      expect(replies.some((reply) => reply?.includes("[openclaw] done: gateway.restart"))).toBe(
        true,
      );
    });
  });

  it("keeps failed execution consumed", async () => {
    await withRescueStateDir("failed-consumed-", async () => {
      const cfg: OpenClawConfig = {};
      vi.mocked(runDaemonRestart).mockImplementation(async () => {
        throw new Error("restart failed");
      });

      await runRescue("/openclaw restart gateway", cfg, commandContext());
      await expect(runRescue("/openclaw yes", cfg, commandContext())).rejects.toThrow(
        "restart failed",
      );
      await expect(runRescue("/openclaw yes", cfg, commandContext())).resolves.toBe(
        "No pending OpenClaw rescue change is waiting for approval.",
      );
      expect(runDaemonRestart).toHaveBeenCalledTimes(1);
    });
  });

  it("preserves a new plan created while the consumed plan executes", async () => {
    await withRescueStateDir("replacement-during-execute-", async () => {
      const cfg: OpenClawConfig = {};
      let releaseRestart: (() => void) | undefined;
      let noteRestartEntered: (() => void) | undefined;
      const restartEntered = new Promise<void>((resolve) => {
        noteRestartEntered = resolve;
      });
      const restartGate = new Promise<void>((resolve) => {
        releaseRestart = resolve;
      });
      vi.mocked(runDaemonRestart).mockImplementation(async () => {
        noteRestartEntered?.();
        await restartGate;
        return true;
      });

      await runRescue("/openclaw restart gateway", cfg, commandContext());
      const approval = runRescue("/openclaw yes", cfg, commandContext());
      await restartEntered;
      await runRescue("/openclaw start gateway", cfg, commandContext());
      releaseRestart?.();
      await expect(approval).resolves.toContain("[openclaw] done: gateway.restart");
      await expect(runRescue("/openclaw yes", cfg, commandContext())).resolves.toContain(
        "[openclaw] done: gateway.start",
      );
      expect(runDaemonRestart).toHaveBeenCalledTimes(1);
      expect(runDaemonStart).toHaveBeenCalledTimes(1);
    });
  });

  it("publishes concurrently invoked persistent plans in call order", async () => {
    await withRescueStateDir("latest-plan-", async () => {
      const cfg: OpenClawConfig = {};

      const olderPlan = runRescue("/openclaw restart gateway", cfg, commandContext());
      const newerPlan = runRescue("/openclaw start gateway", cfg, commandContext());
      await expect(olderPlan).resolves.toContain("restart the Gateway");
      await expect(newerPlan).resolves.toContain("start the Gateway");
      await expect(runRescue("/openclaw yes", cfg, commandContext())).resolves.toContain(
        "[openclaw] done: gateway.start",
      );
      expect(runDaemonRestart).not.toHaveBeenCalled();
      expect(runDaemonStart).toHaveBeenCalledTimes(1);
    });
  });

  it("revokes an invalid replacement through the worker without caller-thread SQL", async () => {
    await withRescueStateDir("replacement-revocation-", async () => {
      const sql = observeHostDataSql();
      try {
        await runRescue("/openclaw restart gateway", {}, commandContext());
        await expect(
          runRescue(`/openclaw config set example ${"x".repeat(1_100_000)}`, {}),
        ).rejects.toThrow(/plugin state value/i);
        await expect(runRescue("/openclaw yes", {}, commandContext())).resolves.toContain(
          "No pending OpenClaw rescue change",
        );
        await runRescue("/openclaw restart gateway", {}, commandContext());
        await expect(runRescue("/openclaw no", {})).resolves.toContain("Dropped the pending");
        expect(sql.queries).toEqual([]);
        expect(runDaemonRestart).not.toHaveBeenCalled();
      } finally {
        sql.restore();
      }
    });
  });

  it.each(["admission", "effect"] as const)(
    "rechecks rescue authority at %s after consuming approval becomes asynchronous",
    async (stage) => {
      await withRescueStateDir(`revoked-${stage}-`, async () => {
        await runRescue("/openclaw restart gateway", {}, commandContext());
        let current = true;
        const command = commandContext({
          assertOwnerCurrent: () => {
            if (!current) {
              throw new Error("rescue owner revoked");
            }
          },
        });
        if (stage === "effect") {
          const snapshot = await mockConfig.readConfigFileSnapshot();
          mockConfig.readConfigFileSnapshot.mockImplementationOnce(async () => {
            current = false;
            return snapshot;
          });
        }
        const approving = runRescue("/openclaw yes", {}, command);
        if (stage === "admission") {
          current = false;
        }
        await expect(approving).rejects.toThrow();
        expect(runDaemonRestart).not.toHaveBeenCalled();
        expect(openRescuePendingTestStore().entries()).toHaveLength(stage === "admission" ? 1 : 0);
      });
    },
  );

  it("persists a pending approval only in SQLite across store reopen", async () => {
    await withRescueStateDir("sqlite-reopen-", async (stateDir) => {
      const cfg: OpenClawConfig = {};

      await runRescue("/openclaw restart gateway", cfg, commandContext());
      resetPluginStateStoreForTests();

      await expect(runRescue("/openclaw yes", cfg, commandContext())).resolves.toContain(
        "[openclaw] done: gateway.restart",
      );
      expect(runDaemonRestart).toHaveBeenCalledTimes(1);
      await expect(fs.access(path.join(stateDir, "openclaw", "rescue-pending"))).rejects.toThrow(
        /ENOENT/,
      );
    });
  });

  it("isolates pending approvals by account, channel, and sender", async () => {
    await withRescueStateDir("route-isolation-", async () => {
      const cfg: OpenClawConfig = {};
      const original = commandContext();

      await runRescue("/openclaw restart gateway", cfg, original);
      for (const isolated of [
        commandContext({ accountId: "secondary" }),
        commandContext({ channelId: "telegram" }),
        commandContext({ from: "user:other", senderId: "user:other" }),
      ]) {
        await expect(runRescue("/openclaw yes", cfg, isolated)).resolves.toBe(
          "No pending OpenClaw rescue change is waiting for approval.",
        );
      }
      await expect(runRescue("/openclaw yes", cfg, original)).resolves.toContain(
        "[openclaw] done: gateway.restart",
      );
      expect(runDaemonRestart).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back to the channel destination when account id is absent", async () => {
    await withRescueStateDir("route-account-fallback-", async () => {
      const cfg: OpenClawConfig = {};
      const original = commandContext({ accountId: undefined, to: "bot:primary" });

      await runRescue("/openclaw restart gateway", cfg, original);
      await expect(
        runRescue(
          "/openclaw yes",
          cfg,
          commandContext({ accountId: undefined, to: "bot:secondary" }),
        ),
      ).resolves.toBe("No pending OpenClaw rescue change is waiting for approval.");
      await expect(runRescue("/openclaw yes", cfg, original)).resolves.toContain(
        "[openclaw] done: gateway.restart",
      );
      expect(runDaemonRestart).toHaveBeenCalledTimes(1);
    });
  });

  it("refuses plugin install from remote rescue", async () => {
    const cfg: OpenClawConfig = {};

    await expect(
      runRescue("/openclaw plugin install clawhub:openclaw-demo", cfg),
    ).resolves.toContain("cannot install plugins from a message channel");
    expect(runPluginInstallCommandMock).not.toHaveBeenCalled();
  });

  it("allows plugin list and search from remote rescue", async () => {
    const cfg: OpenClawConfig = {};
    vi.mocked(runPluginsListCommand).mockImplementation(async (_opts, runtime) => {
      runtime?.log("plugin rows");
    });
    vi.mocked(runPluginsSearchCommand).mockImplementation(async (query, _opts, runtime) => {
      runtime?.log(`search rows: ${String(query)}`);
    });

    await expect(runRescue("/openclaw plugins list", cfg, commandContext())).resolves.toContain(
      "plugin rows",
    );
    await expect(
      runRescue("/openclaw plugins search calendar", cfg, commandContext()),
    ).resolves.toContain("search rows: calendar");
    expect(runPluginsListCommand).toHaveBeenCalledTimes(1);
    expect(runPluginsSearchCommand).toHaveBeenCalledTimes(1);
    const [searchQuery, , searchRuntime] = requireFirstMockCall(
      vi.mocked(runPluginsSearchCommand),
      "plugins search",
    );
    expect(searchQuery).toBe("calendar");
    expect(searchRuntime).toBeTypeOf("object");
  });

  it.each([undefined, "work"])(
    "queues and applies model selection for agent %s through conversational approval",
    async (agentId) => {
      await withRescueStateDir("models-", async () => {
        const cfg: OpenClawConfig = {};
        if (agentId) {
          await mockConfig.mutateConfigFile({
            mutate: (draft) => {
              draft.agents = { entries: { [agentId]: {} } };
            },
          });
        }
        vi.mocked(verifySetupInferenceConfig).mockImplementation(async () => ({
          ok: true as const,
          modelRef: "openai/gpt-5.2",
          latencyMs: 17,
        }));
        await expect(
          runRescue(
            `/openclaw set default model openai/gpt-5.2${agentId ? ` for agent ${agentId}` : ""}`,
            cfg,
            commandContext(),
          ),
        ).resolves.toContain("Reply /openclaw yes to apply");
        await expect(runRescue("/openclaw yes", cfg, commandContext())).resolves.toContain(
          agentId ? `Agent ${agentId} model: openai/gpt-5.2` : "Default model: openai/gpt-5.2",
        );

        const currentConfig = mockConfig.currentConfig() as OpenClawConfig;
        const model = agentId
          ? currentConfig.agents?.entries?.[agentId]?.model
          : currentConfig.agents?.defaults?.model;
        expect(typeof model === "string" ? model : model?.primary).toBe("openai/gpt-5.2");
        if (agentId) {
          expect(currentConfig.agents?.defaults?.model).toBeUndefined();
        }
        const audit = readLastAuditEntry() as {
          details?: { rescue?: boolean; channel?: string; accountId?: string; senderId?: string };
        };
        expect(audit.details?.rescue).toBe(true);
        expect(audit.details?.channel).toBe("whatsapp");
        expect(audit.details?.accountId).toBe("default");
        expect(audit.details?.senderId).toBe("user:owner");
      });
    },
  );

  it("does not queue persistent rescue approval when expiry would exceed the Date range", async () => {
    await withRescueStateDir("overflow-expiry-", async (tempDir) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(8_640_000_000_000_000));
      try {
        const cfg: OpenClawConfig = {};

        await expect(
          runRescue("/openclaw restart gateway", cfg, commandContext()),
        ).resolves.toContain("expiry clock is invalid");

        await expect(fs.readdir(path.join(tempDir, "openclaw", "rescue-pending"))).rejects.toThrow(
          /ENOENT/,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("expires pending approvals through the SQLite row TTL", async () => {
    await withRescueStateDir("expired-", async () => {
      const cfg: OpenClawConfig = {};

      await runRescue("/openclaw restart gateway", {}, commandContext());
      const store = openRescuePendingTestStore();
      const [entry] = store.entries();
      assert(entry, "expected pending rescue row");
      expect(entry.expiresAt! - entry.createdAt).toBe(15 * 60_000);
      // The worker owns its clock. Seed a foreign expired row through the SDK
      // instead of advancing only the host's clock.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      store.register(entry.key, entry.value, { ttlMs: 15 * 60_000 });
      vi.useRealTimers();

      await expect(runRescue("/openclaw yes", cfg, commandContext())).resolves.toBe(
        "No pending OpenClaw rescue change is waiting for approval.",
      );
      expect(runDaemonRestart).not.toHaveBeenCalled();
    });
  });

  it("consumes malformed pending rows without executing them", async () => {
    await withRescueStateDir("malformed-", async () => {
      const cfg: OpenClawConfig = {};

      await runRescue("/openclaw restart gateway", cfg, commandContext());
      const store = openRescuePendingTestStore();
      const [entry] = store.entries();
      assert(entry, "expected pending rescue row");
      store.register(
        entry.key,
        { version: 1, operation: { kind: "gateway-restart", unexpected: true } },
        { ttlMs: 60_000 },
      );

      await expect(runRescue("/openclaw yes", cfg, commandContext())).resolves.toBe(
        "No pending OpenClaw rescue change is waiting for approval.",
      );
      await expect(runRescue("/openclaw yes", cfg, commandContext())).resolves.toBe(
        "No pending OpenClaw rescue change is waiting for approval.",
      );
      expect(runDaemonRestart).not.toHaveBeenCalled();
    });
  });

  it.each([
    { role: "writer", name: undefined },
    { role: undefined, name: "QA Writer" },
    { role: "writer", name: "QA Writer", purpose: "Write release notes" },
  ])(
    "queues and applies agent creation with role $role, name $name and purpose $purpose through conversational approval",
    async ({ role, name, purpose }) => {
      await withRescueStateDir("agent-", async () => {
        const cfg: OpenClawConfig = {};
        vi.mocked(createAgent).mockImplementation(async () => ({
          status: "created" as const,
          agentId: "work",
          name: name ?? "work",
          workspace: "/tmp/work",
          agentDir: "/tmp/agent-work",
          bootstrapPending: true,
          config: cfg,
          configPath: "/tmp/openclaw.json",
        }));

        await expect(
          runRescue(
            `/openclaw create agent work${name ? ` name ${JSON.stringify(name)}` : ""}${role ? ` role ${role}` : ""}${purpose ? ` purpose ${JSON.stringify(purpose)}` : ""} workspace /tmp/work`,
            cfg,
            commandContext(),
          ),
        ).resolves.toBe(
          `Plan: create agent work with workspace /tmp/work${name ? `, name: ${JSON.stringify(name)}` : ""}${purpose ? `, purpose: ${JSON.stringify(purpose)}` : ""}${role ? ", role: Writer" : ""}. Reply /openclaw yes to apply.`,
        );
        expect(createAgent).not.toHaveBeenCalled();
        await expect(runRescue("/openclaw yes", cfg, commandContext())).resolves.toContain(
          "[openclaw] done: agents.create",
        );

        expect(createAgent).toHaveBeenCalledTimes(1);
        expect(createAgent).toHaveBeenCalledWith({
          entry: {
            id: "work",
            ...(name ? { name, identity: { name } } : {}),
          },
          ...(role ? { role } : {}),
          ...(purpose ? { purpose } : {}),
          workspace: "/tmp/work",
          provenance: { createdVia: "agent", creatorAgentId: "openclaw" },
          beforePersistentApply: expect.any(Function),
        });
        const audit = readLastAuditEntry() as {
          operation?: string;
          details?: {
            rescue?: boolean;
            channel?: string;
            senderId?: string;
            agentId?: string;
            workspace?: string;
          };
        };
        expect(audit.operation).toBe("agents.create");
        expect(audit.details?.rescue).toBe(true);
        expect(audit.details?.channel).toBe("whatsapp");
        expect(audit.details?.senderId).toBe("user:owner");
        expect(audit.details?.agentId).toBe("work");
        expect(audit.details?.workspace).toBe("/tmp/work");
      });
    },
  );
});
