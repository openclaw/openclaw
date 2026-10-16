import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
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

  it("shows effective sandbox alsoAllow grants and default-deny removals", async () => {
    mockCfg = config(
      { mode: "all", scope: "agent", workspaceAccess: "none" },
      { tavern: { tools: { sandbox: { tools: { alsoAllow: ["message", "tts"] } } } } },
      {
        tools: { sandbox: { tools: { allow: ["browser"] } } },
        session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" },
      },
    );

    const {
      sandbox: { tools },
    } = await explain({ agent: "tavern" });
    expect(tools.allow).toEqual(["browser", "message", "tts", "view_image"]);
    expect(tools.deny).not.toContain("browser");
    const source = { source: "agent", key: "agents.entries.*.tools.sandbox.tools.alsoAllow" };
    expect(tools.sources.allow).toEqual(source);
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
      const sessions = [
        { key: "agent:builder:guest-a-first", principalId: "guest-a" },
        { key: "agent:builder:guest-a-second", principalId: "guest-a" },
        { key: "agent:builder:guest-b", principalId: "guest-b" },
      ];
      for (const session of sessions) {
        await replaceSessionEntry(
          { storePath, sessionKey: session.key },
          {
            sessionId: session.key,
            updatedAt: Date.now(),
            sandbox: "required",
            createdActor: { type: "human", source: "profile", id: session.principalId },
          },
        );
      }
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

      const workspaceRoots: string[] = [];
      const readonlyMounts = ["workspace", "agent"].map((source) =>
        expect.objectContaining({ source, writable: false }),
      );
      for (const session of sessions) {
        const { sandbox } = await explain({ session: session.key });
        expect(sandbox).toMatchObject({
          scope: "agent",
          workspaceAccess: "ro",
          workspaceSource: "sandbox",
          sessionIsSandboxed: true,
        });
        expect(sandbox.effectiveHostWorkspaceRoot).not.toBe(path.resolve(state.workspaceDir));
        expect(sandbox.workspaceMounts).toEqual(expect.arrayContaining(readonlyMounts));
        workspaceRoots.push(sandbox.effectiveHostWorkspaceRoot);
      }

      expect(workspaceRoots[0]).toBe(workspaceRoots[1]);
      expect(workspaceRoots[0]).not.toBe(workspaceRoots[2]);
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
    await expect(execution).rejects.toThrow('agent "builder" does not match session agent "main"');
  });
});
