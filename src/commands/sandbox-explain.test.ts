import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { sandboxExplainCommand } from "./sandbox-explain.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sandbox-explain-");
const workspace = path.resolve("/tmp/openclaw-agent-workspace");
const childWorkspace = "/tmp/openclaw-child-workspace";
const childCwd = `${childWorkspace}/task`;

let mockCfg: unknown = {};
type Agents = NonNullable<OpenClawConfig["agents"]>;

function config(
  sandbox: NonNullable<Agents["defaults"]>["sandbox"],
  entries: Agents["entries"],
  rest: Omit<OpenClawConfig, "agents"> = {},
  agentOptions: Pick<Agents, "ownership"> = {},
) {
  return { agents: { defaults: { sandbox }, entries, ...agentOptions }, ...rest };
}

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: vi.fn(() => mockCfg),
  loadConfig: vi.fn(() => mockCfg),
  captureRuntimeConfigAsyncReader: () => async () => mockCfg,
}));

async function explain(opts: Omit<Parameters<typeof sandboxExplainCommand>[0], "json">) {
  const logs: string[] = [];
  const log = (message: unknown) => logs.push(String(message));
  const options = { json: true, ...opts };
  await sandboxExplainCommand(options, { log, error: log, exit: vi.fn() });
  return JSON.parse(logs.join(""));
}

describe("sandbox explain command", () => {
  it.each([
    {
      label: "canonical delivery before legacy key",
      session: "agent:builder:telegram:direct:peer",
      sessionKey: "agent:builder:telegram:direct:peer",
      delivery: "slack",
      channel: "slack",
      mainKey: "main",
    },
    {
      label: "internal delivery without registration",
      session: "agent:builder:telegram:direct:peer",
      sessionKey: "agent:builder:telegram:direct:peer",
      delivery: "webchat",
      channel: "webchat",
      mainKey: "main",
    },
    {
      label: "unknown delivery falls back to legacy key",
      session: "agent:builder:telegram:direct:peer",
      sessionKey: "agent:builder:telegram:direct:peer",
      delivery: "unregistered-channel",
      channel: "telegram",
      mainKey: "main",
    },
    {
      label: "short configured main is not a channel",
      session: "telegram",
      sessionKey: "agent:builder:telegram",
      delivery: undefined,
      channel: undefined,
      mainKey: "telegram",
    },
    {
      label: "blank session selects configured main",
      session: "   ",
      sessionKey: "agent:builder:operator",
      delivery: undefined,
      channel: undefined,
      mainKey: "operator",
    },
    {
      label: "main alias selects configured main",
      session: "main",
      sessionKey: "agent:builder:operator",
      delivery: undefined,
      channel: undefined,
      mainKey: "operator",
    },
    {
      label: "unscoped slash alias without stored metadata",
      session: "telegram:slash:123",
      sessionKey: "agent:builder:telegram:slash:123",
      delivery: undefined,
      channel: "telegram",
      mainKey: "main",
    },
    {
      label: "scoped slash key without stored metadata",
      session: "agent:builder:telegram:slash:123",
      sessionKey: "agent:builder:telegram:slash:123",
      delivery: undefined,
      channel: "telegram",
      mainKey: "main",
    },
    {
      label: "stored delivery for an unscoped slash alias",
      session: "telegram:slash:123",
      sessionKey: "agent:builder:telegram:slash:123",
      delivery: "slack",
      channel: "slack",
      mainKey: "main",
    },
    {
      label: "unknown alias without channel or sender evidence",
      session: "unregistered-channel:slash:123",
      sessionKey: "agent:builder:unregistered-channel:slash:123",
      delivery: undefined,
      channel: undefined,
      mainKey: "main",
    },
  ])(
    "reports $label through the stored session",
    async ({ session, sessionKey, delivery, channel, mainKey }) => {
      const previousRegistry = captureActivePluginRegistrySnapshot();
      try {
        setActivePluginRegistry(
          createTestRegistry(
            ["telegram", "slack"].map((id) => ({
              pluginId: id,
              plugin: createChannelTestPluginBase({ id }),
              source: "test",
            })),
          ),
        );
        await withOpenClawTestState({ label: "sandbox-explain-channel" }, async (state) => {
          const storePath = path.join(state.sessionsDir("builder"), "sessions.json");
          if (delivery) {
            await replaceSessionEntry(
              { storePath, sessionKey },
              {
                sessionId: "explain-session",
                updatedAt: 1,
                delivery: {
                  kind: "external",
                  route: { channel: delivery, target: { to: "synthetic-peer" } },
                  context: { channel: delivery, to: "synthetic-peer" },
                  origin: { provider: delivery },
                },
              },
            );
          }
          mockCfg = config(
            { mode: "off" },
            { builder: { workspace: state.workspaceDir } },
            {
              session: { store: storePath, mainKey },
              tools: { elevated: { allowFrom: { telegram: ["*"], slack: ["*"], webchat: ["*"] } } },
            },
          );
          const result = await explain({ session });
          expect(result.sessionKey).toBe(sessionKey);
          expect(result.elevated.channel).toBe(channel);
          expect(result.elevated.allowedByConfig).toBe(channel !== undefined);
          expect(result.elevated.allowFrom.global).toEqual(channel ? ["*"] : undefined);
          if (channel) {
            expect(result.fixIt).toContain(`tools.elevated.allowFrom.${channel}`);
          }
        });
      } finally {
        restoreActivePluginRegistrySnapshot(previousRegistry);
      }
    },
  );

  it.each([
    [
      "unknown",
      "nope-agent",
      'Unknown agent id "nope-agent". Run openclaw agents list to see configured agents.',
    ],
    ["blank", "", "--agent must not be blank"],
  ])("rejects an explicit %s agent", async (_label, agent, message) => {
    mockCfg = config({ mode: "off" }, { main: {} });
    await expect(explain({ agent })).rejects.toThrow(message);
  });

  it("reads a missing session without creating or registering an agent database", async () => {
    await withOpenClawTestState({ label: "sandbox-explain-readonly" }, async (state) => {
      const agentDatabasePath = path.join(state.agentDir("readonly"), "openclaw-agent.sqlite");
      mockCfg = config(
        { mode: "off" },
        { readonly: { workspace: state.workspaceDir } },
        { session: { store: agentDatabasePath } },
      );
      const stateDatabase = openOpenClawStateDatabase({ env: state.env });

      await explain({ agent: "readonly" });

      expect(stateDatabase.db.prepare("SELECT agent_id FROM agent_databases").all()).toEqual([]);
      await expect(fs.stat(agentDatabasePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("reports the effective rw workspace and podman mount without changing workspaceRoot", async () => {
    mockCfg = config(
      {
        mode: "all",
        backend: "podman",
        scope: "agent",
        workspaceAccess: "rw",
        workspaceRoot: "/tmp/openclaw-sandboxes",
      },
      { builder: { workspace }, research: { workspace: "/tmp/openclaw-research-workspace" } },
      { session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" } },
      { ownership: "explicit" },
    );

    const { agentId, sandbox } = await explain({ agent: "builder" });
    expect(agentId).toBe("builder");
    expect(sandbox).toMatchObject({
      backend: "podman",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      effectiveHostWorkspaceRoot: workspace,
      runtimeWorkdir: "/workspace",
      workspaceSource: "agent",
    });
    expect(sandbox.workspaceMounts).toEqual([
      { hostRoot: workspace, containerRoot: "/workspace", writable: true, source: "workspace" },
    ]);
  });

  it("reports guest-isolated workspaces and the effective writable-access cap", async () => {
    await withOpenClawTestState({ label: "sandbox-explain-guests" }, async (state) => {
      const storePath = path.join(state.sessionsDir("builder"), "sessions.json");
      const sessionKey = "agent:builder:guest";
      await replaceSessionEntry(
        { storePath, sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: Date.now(),
          sandbox: "required",
          createdActor: { type: "human", source: "profile", id: "guest" },
        },
      );
      mockCfg = config(
        {
          mode: "off",
          scope: "shared",
          workspaceAccess: "rw",
          workspaceRoot: state.statePath("sandboxes"),
        },
        { builder: { workspace: state.workspaceDir } },
        { session: { store: storePath } },
      );

      const readonlyMounts = ["workspace", "agent"].map((source) =>
        expect.objectContaining({ source, writable: false }),
      );
      const { sandbox } = await explain({ session: sessionKey });
      expect(sandbox).toMatchObject({
        scope: "agent",
        workspaceAccess: "ro",
        workspaceSource: "sandbox",
        sessionIsSandboxed: true,
      });
      expect(sandbox.effectiveHostWorkspaceRoot).not.toBe(path.resolve(state.workspaceDir));
      expect(sandbox.workspaceMounts).toEqual(expect.arrayContaining(readonlyMounts));
    });
  });

  it("uses persisted spawned-session workspace and cwd overrides", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const sessionKey = "agent:builder:subagent:child";
    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "child-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:builder:main",
        spawnedWorkspaceDir: childWorkspace,
        spawnedCwd: childCwd,
      },
    );
    mockCfg = config(
      { mode: "off" },
      { builder: { workspace } },
      { session: { store: storePath } },
    );

    const { sandbox } = await explain({ session: sessionKey });
    expect(sandbox).toMatchObject({
      effectiveHostWorkspaceRoot: path.resolve(childWorkspace),
      runtimeWorkdir: childCwd,
      workspaceSource: "direct",
    });
  });

  it("uses the sole configured agent for global sessions", async () => {
    mockCfg = config(
      { mode: "non-main" },
      { ops: { workspace: "/tmp/openclaw-ops-workspace" } },
      { session: { scope: "global" } },
    );

    const parsed = await explain({ agent: "ops", session: "global" });
    expect(parsed).toMatchObject({
      agentId: "ops",
      sandbox: {
        sessionIsSandboxed: false,
        effectiveHostWorkspaceRoot: path.resolve("/tmp/openclaw-ops-workspace"),
      },
    });
  });

  it("rejects a fully qualified session from a different agent", async () => {
    mockCfg = config({ mode: "non-main" }, { main: {}, builder: {} });
    const execution = explain({ agent: "builder", session: "agent:main:main" });
    await expect(execution).rejects.toThrow('belongs to "main", not "builder"');
  });
});
