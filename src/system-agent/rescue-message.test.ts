import assert from "node:assert/strict";
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
import { runTui } from "../tui/tui.js";
import { listSystemAgentAuditEntriesForTests } from "./audit.test-support.js";
import { extractSystemAgentRescueMessage, runSystemAgentRescueMessage } from "./rescue-message.js";
import { verifySetupInferenceConfig } from "./setup-inference.js";

let tempRoot = "";
let tempDirId = 0;
let stateDir = "";

type TestConfig = Record<string, unknown>;

const readLastAuditEntry = () => listSystemAgentAuditEntriesForTests().at(-1)?.value ?? {};

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
      state.config = {};
      state.hash = "mock-hash-0";
    },
    currentConfig: cloneConfig,
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
  // Avoid a plugin-registry scan; model persistence itself is covered by its owner.
  const update: typeof actual.applyDefaultModelPrimaryUpdate = ({ cfg, modelRaw, field }) => ({
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: { ...cfg.agents?.defaults, [field]: { primary: modelRaw } },
    },
  });
  return { ...actual, applyDefaultModelPrimaryUpdate: update };
});

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

async function runRescue(commandBody: string, cfg: OpenClawConfig = {}, ctx = commandContext()) {
  return await runSystemAgentRescueMessage({
    cfg,
    command: { ...ctx, commandBodyNormalized: commandBody },
    commandBody,
    isGroup: false,
  });
}

async function expectReply(command: string, text: string, exact = false, ctx = commandContext()) {
  const reply = await runRescue(command, {}, ctx);
  if (exact) {
    expect(reply).toBe(text);
  } else {
    expect(reply).toContain(text);
  }
}
const noPending = "No pending OpenClaw rescue change is waiting for approval.";

describe("OpenClaw rescue message", () => {
  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "system-agent-rescue-"));
  });

  beforeEach(async () => {
    stateDir = path.join(tempRoot, String(tempDirId++));
    await fs.mkdir(stateDir, { recursive: true });
    resetPluginStateStoreForTests();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
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

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await closeOpenClawStateDatabaseAsync();
    } finally {
      resetPluginStateStoreForTests();
      vi.unstubAllEnvs();
    }
  });

  it("recognizes the OpenClaw rescue command", () => {
    expect(extractSystemAgentRescueMessage("/openclaw status")).toBe("status");
    expect(extractSystemAgentRescueMessage("/openclaw")).toBe("");
    expect(extractSystemAgentRescueMessage("/status")).toBeNull();
  });

  it.each([
    ["talk to agent", "cannot open the local TUI", runTui],
    ["chat", "cannot open the local TUI", runTui],
    ["connect telegram", "cannot host the interactive channel setup", undefined],
    [
      "plugin install clawhub:openclaw-demo",
      "cannot install plugins from a message channel",
      runPluginInstallCommandMock,
    ],
  ] as const)("refuses remote %s", async (command, reason, effect) => {
    await expectReply(`/openclaw ${command}`, reason);
    if (effect) {
      expect(effect).not.toHaveBeenCalled();
    }
  });

  it("rejects natural language instead of guessing an operation", async () => {
    // Questions must never become mutation plans (previously "why did my
    // gateway stop" keyword-matched into a gateway-stop proposal).
    await expectReply("/openclaw why did my gateway stop", "I can run doctor/status/health");
    await expectReply(
      "/openclaw explain how restart gateway works",
      "I can run doctor/status/health",
    );
    expect(runDaemonStop).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
  });

  it("refuses doctor repairs without creating a pending approval", async () => {
    const reply = await runRescue("/openclaw doctor fix", {});
    expect(reply).toContain("machine running OpenClaw");
    expect(reply).toContain("with OpenClaw stopped");
    expect(reply).toContain("run `openclaw doctor --fix`");
    await expectReply("/openclaw yes", noPending, true);
  });

  it("refuses config deletion without creating a pending approval or writing config", async () => {
    const before = mockConfig.currentConfig();
    mockConfig.mutateConfigFile.mockClear();

    await expectReply(
      "/openclaw config unset agents.defaults.fastModeDefault",
      "cannot remove configuration settings",
    );
    await expectReply("/openclaw yes", noPending, true);
    expect(mockConfig.mutateConfigFile).not.toHaveBeenCalled();
    expect(mockConfig.currentConfig()).toEqual(before);
    expect(listSystemAgentAuditEntriesForTests()).toEqual([]);
  });

  it("drops a pending rescue change on decline", async () => {
    await expectReply("/openclaw restart gateway", "Reply /openclaw yes to apply");
    await expectReply("/openclaw no", "Dropped the pending OpenClaw rescue change");
    await expectReply("/openclaw yes", noPending, true);
    expect(runDaemonRestart).not.toHaveBeenCalled();
  });

  it("revokes a pending write when a fresh read-only command arrives", async () => {
    vi.mocked(runPluginsListCommand).mockImplementation(async (_opts, runtime) =>
      runtime?.log("plugin rows"),
    );

    await expectReply("/openclaw restart gateway", "Reply /openclaw yes to apply");
    await expectReply("/openclaw plugins list", "plugin rows", true);
    await expectReply("/openclaw yes", noPending, true);
    expect(runDaemonRestart).not.toHaveBeenCalled();
  });

  it("consumes a pending approval at most once under concurrent approvals", async () => {
    await runRescue("/openclaw restart gateway", {});
    const replies = await Promise.all([
      runRescue("/openclaw yes", {}),
      runRescue("/openclaw yes", {}),
    ]);

    expect(runDaemonRestart).toHaveBeenCalledTimes(1);
    expect(replies).toContain(noPending);
    expect(replies.some((reply) => reply?.includes("[openclaw] done: gateway.restart"))).toBe(true);
  });

  it("keeps failed execution consumed", async () => {
    vi.mocked(runDaemonRestart).mockImplementation(async () => {
      throw new Error("restart failed");
    });

    await runRescue("/openclaw restart gateway", {});
    await expect(runRescue("/openclaw yes", {})).rejects.toThrow("restart failed");
    await expectReply("/openclaw yes", noPending, true);
    expect(runDaemonRestart).toHaveBeenCalledTimes(1);
  });

  it("preserves a new plan created while the consumed plan executes", async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    vi.mocked(runDaemonRestart).mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return true;
    });

    await runRescue("/openclaw restart gateway", {});
    const approval = runRescue("/openclaw yes", {});
    await entered.promise;
    await runRescue("/openclaw start gateway", {});
    gate.resolve();
    await expect(approval).resolves.toContain("[openclaw] done: gateway.restart");
    await expectReply("/openclaw yes", "[openclaw] done: gateway.start");
    expect(runDaemonRestart).toHaveBeenCalledTimes(1);
    expect(runDaemonStart).toHaveBeenCalledTimes(1);
  });

  it("publishes concurrently invoked persistent plans in call order", async () => {
    const olderPlan = runRescue("/openclaw restart gateway", {});
    const newerPlan = runRescue("/openclaw start gateway", {});
    await expect(olderPlan).resolves.toContain("restart the Gateway");
    await expect(newerPlan).resolves.toContain("start the Gateway");
    await expectReply("/openclaw yes", "[openclaw] done: gateway.start");
    expect(runDaemonRestart).not.toHaveBeenCalled();
    expect(runDaemonStart).toHaveBeenCalledTimes(1);
  });

  it("revokes an invalid replacement through the worker without caller-thread SQL", async () => {
    const sql = observeHostDataSql();
    try {
      await runRescue("/openclaw restart gateway", {});
      await expect(
        runRescue(`/openclaw config set example ${"x".repeat(1_100_000)}`, {}),
      ).rejects.toThrow(/plugin state value/i);
      await expectReply("/openclaw yes", "No pending OpenClaw rescue change");
      await runRescue("/openclaw restart gateway", {});
      await expectReply("/openclaw no", "Dropped the pending");
      expect(sql.queries).toEqual([]);
      expect(runDaemonRestart).not.toHaveBeenCalled();
    } finally {
      sql.restore();
    }
  });

  it.each(["admission", "effect"] as const)(
    "rechecks rescue authority at %s after consuming approval becomes asynchronous",
    async (stage) => {
      await runRescue("/openclaw restart gateway", {});
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
    },
  );

  it("persists a pending approval only in SQLite across store reopen", async () => {
    await runRescue("/openclaw restart gateway", {});
    resetPluginStateStoreForTests();

    await expectReply("/openclaw yes", "[openclaw] done: gateway.restart");
    expect(runDaemonRestart).toHaveBeenCalledTimes(1);
    await expect(fs.access(path.join(stateDir, "openclaw", "rescue-pending"))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it.each([
    ["account", {}, { accountId: "secondary" }],
    ["channel", {}, { channelId: "telegram" }],
    ["sender", {}, { from: "user:other", senderId: "user:other" }],
    [
      "destination fallback",
      { accountId: undefined, to: "bot:primary" },
      { accountId: undefined, to: "bot:secondary" },
    ],
  ] as const)("isolates pending approvals by %s", async (_scope, base, other) => {
    const original = commandContext(base);
    await runRescue("/openclaw restart gateway", {}, original);
    await expectReply("/openclaw yes", noPending, true, commandContext(other));
    await expectReply("/openclaw yes", "[openclaw] done: gateway.restart", false, original);
    expect(runDaemonRestart).toHaveBeenCalledTimes(1);
  });

  it("allows plugin list and search from remote rescue", async () => {
    vi.mocked(runPluginsListCommand).mockImplementation(async (_opts, runtime) => {
      runtime?.log("plugin rows");
    });
    vi.mocked(runPluginsSearchCommand).mockImplementation(async (query, _opts, runtime) => {
      runtime?.log(`search rows: ${String(query)}`);
    });

    await expectReply("/openclaw plugins list", "plugin rows");
    await expectReply("/openclaw plugins search calendar", "search rows: calendar");
    expect(runPluginsListCommand).toHaveBeenCalledTimes(1);
    expect(runPluginsSearchCommand).toHaveBeenCalledTimes(1);
    const [searchQuery, , searchRuntime] = vi.mocked(runPluginsSearchCommand).mock.calls[0]!;
    expect(searchQuery).toBe("calendar");
    expect(searchRuntime).toBeTypeOf("object");
  });

  it.each([undefined, "work"])(
    "queues and applies model selection for agent %s through conversational approval",
    async (agentId) => {
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
          {},
          commandContext(),
        ),
      ).resolves.toContain("Reply /openclaw yes to apply");
      await expect(runRescue("/openclaw yes", {})).resolves.toContain(
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
      expect(readLastAuditEntry()).toMatchObject({
        details: {
          rescue: true,
          channel: "whatsapp",
          accountId: "default",
          senderId: "user:owner",
        },
      });
    },
  );

  it("does not queue persistent rescue approval when expiry would exceed the Date range", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    try {
      await expectReply("/openclaw restart gateway", "expiry clock is invalid");

      await expect(fs.readdir(path.join(stateDir, "openclaw", "rescue-pending"))).rejects.toThrow(
        /ENOENT/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires pending approvals through the SQLite row TTL", async () => {
    await runRescue("/openclaw restart gateway", {});
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

    await expectReply("/openclaw yes", noPending, true);
    expect(runDaemonRestart).not.toHaveBeenCalled();
  });

  it("consumes malformed pending rows without executing them", async () => {
    await runRescue("/openclaw restart gateway", {});
    const store = openRescuePendingTestStore();
    const [entry] = store.entries();
    assert(entry, "expected pending rescue row");
    store.register(
      entry.key,
      { version: 1, operation: { kind: "gateway-restart", unexpected: true } },
      { ttlMs: 60_000 },
    );

    await expectReply("/openclaw yes", noPending, true);
    await expectReply("/openclaw yes", noPending, true);
    expect(runDaemonRestart).not.toHaveBeenCalled();
  });

  it.each([
    { role: "writer", name: undefined },
    { role: undefined, name: "QA Writer" },
    { role: "writer", name: "QA Writer", purpose: "Write release notes" },
  ])(
    "queues and applies agent creation with role $role, name $name and purpose $purpose through conversational approval",
    async ({ role, name, purpose }) => {
      vi.mocked(createAgent).mockImplementation(async () => ({
        status: "created" as const,
        agentId: "work",
        name: name ?? "work",
        workspace: "/tmp/work",
        agentDir: "/tmp/agent-work",
        bootstrapPending: true,
        config: {},
        configPath: "/tmp/openclaw.json",
      }));

      await expect(
        runRescue(
          `/openclaw create agent work${name ? ` name ${JSON.stringify(name)}` : ""}${role ? ` role ${role}` : ""}${purpose ? ` purpose ${JSON.stringify(purpose)}` : ""} workspace /tmp/work`,
          {},
          commandContext(),
        ),
      ).resolves.toBe(
        `Plan: create agent work with workspace /tmp/work${name ? `, name: ${JSON.stringify(name)}` : ""}${purpose ? `, purpose: ${JSON.stringify(purpose)}` : ""}${role ? ", role: Writer" : ""}. Reply /openclaw yes to apply.`,
      );
      expect(createAgent).not.toHaveBeenCalled();
      await expectReply("/openclaw yes", "[openclaw] done: agents.create");

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
      expect(readLastAuditEntry()).toMatchObject({
        operation: "agents.create",
        details: {
          rescue: true,
          channel: "whatsapp",
          senderId: "user:owner",
          agentId: "work",
          workspace: "/tmp/work",
        },
      });
    },
  );
});
