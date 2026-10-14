import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  createCapturingTestRuntime,
  createTestConfigSnapshot,
  createTestRuntime,
} from "./test-runtime-config-helpers.js";

const TEST_MAX_IDENTITY_FILE_BYTES = 4 * 1024 * 1024;

const configMocks = vi.hoisted(() => {
  const writeConfigFile = vi
    .fn<(config: OpenClawConfig) => Promise<void>>()
    .mockResolvedValue(undefined);
  return {
    readConfigFileSnapshot: vi.fn(),
    writeConfigFile,
    replaceConfigFile: vi.fn(async (params: { sourceConfig: OpenClawConfig }) => {
      await writeConfigFile(params.sourceConfig);
      return { nextConfig: params.sourceConfig };
    }),
  };
});

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
  readConfigFileSnapshotForWrite: async () => {
    const snapshot = await configMocks.readConfigFileSnapshot();
    return {
      snapshot: { ...snapshot, sourceConfig: snapshot.sourceConfig ?? snapshot.config },
      writeOptions: {},
    };
  },
  writeConfigFile: configMocks.writeConfigFile,
  replaceConfigFile: configMocks.replaceConfigFile,
}));

import type { AgentRouteBinding } from "../config/types.js";
import { applyAgentBindings, removeAgentBindings } from "./agents.bindings.js";
import { agentsSetIdentityCommand } from "./agents.commands.identity.js";
import { applyAgentConfig, buildAgentSummaries, pruneAgentConfig } from "./agents.config.js";

const runtime = createTestRuntime();
type IdentityOptions = Parameters<typeof agentsSetIdentityCommand>[0];

function setAgents(agents: OpenClawConfig["agents"]) {
  configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot({ agents }));
}

function writtenAgent(id = "main") {
  return configMocks.writeConfigFile.mock.calls[0]?.[0].agents?.entries?.[id];
}

async function jsonIdentity(options: IdentityOptions) {
  const capture = createCapturingTestRuntime();
  await agentsSetIdentityCommand({ ...options, json: true }, capture.runtime);
  const payload: unknown = JSON.parse(capture.logs.at(-1) ?? "{}");
  return payload;
}

async function createIdentityWorkspace(subdir = "work") {
  const root = await makeTempWorkspace("openclaw-identity-");
  const workspace = path.join(root, subdir);
  await fs.mkdir(workspace, { recursive: true });
  return { root, workspace };
}

async function writeIdentityFile(workspace: string, lines: string[]) {
  const identityPath = path.join(workspace, "IDENTITY.md");
  await fs.writeFile(identityPath, `${lines.join("\n")}\n`, "utf-8");
  return identityPath;
}

async function expectIdentityCommandFailure(options: IdentityOptions, expected: string | RegExp) {
  const message = typeof expected === "string" ? expected : expect.stringMatching(expected);
  await expect(agentsSetIdentityCommand(options, runtime)).rejects.toMatchObject({
    name: "ExpectedCliError",
    message,
    humanOutput: message,
    machineOutput: message,
  });
  expect(runtime.error).not.toHaveBeenCalled();
  expect(runtime.exit).not.toHaveBeenCalled();
  expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
}

describe("agents set-identity command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAgents({ entries: { main: {} } });
  });

  it("resolves --from-identity against the selected agent workspace", async () => {
    const { root, workspace } = await createIdentityWorkspace();
    await writeIdentityFile(workspace, ["- Name: Workspace Agent"]);

    setAgents({ entries: { main: { workspace } } });
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);

    try {
      await agentsSetIdentityCommand({ agent: "main", fromIdentity: true }, runtime);
    } finally {
      cwdSpy.mockRestore();
    }

    expect(writtenAgent()?.identity).toEqual({ name: "Workspace Agent" });
  });

  it("errors when multiple agents match the same workspace", async () => {
    const { workspace } = await createIdentityWorkspace("shared");
    const identityPath = await writeIdentityFile(workspace, ["- Name: Echo"]);
    const originalIdentity = await fs.readFile(identityPath, "utf8");

    setAgents({ entries: { main: { workspace }, ops: { workspace } } });

    await expectIdentityCommandFailure(
      { workspace },
      `Multiple agents match ${workspace}: main, ops. Pass --agent to choose one.`,
    );
    await expect(fs.readFile(identityPath, "utf8")).resolves.toBe(originalIdentity);
  });

  it("rejects an unmatched workspace before reading or changing its identity file", async () => {
    const { workspace } = await createIdentityWorkspace("unmatched");
    const identityPath = await writeIdentityFile(workspace, ["- Name: Untouched"]);
    const originalIdentity = await fs.readFile(identityPath, "utf8");

    await expectIdentityCommandFailure(
      { workspace, name: "Override", json: true },
      `No agent workspace matches ${workspace}. Pass --agent to target a specific agent.`,
    );

    await expect(fs.readFile(identityPath, "utf8")).resolves.toBe(originalIdentity);
  });

  it("sanitizes identity echoes while preserving stored and JSON values", async () => {
    const name = "Operator\u001B]0;identity-injection\u0007🦞\r\nforged-row\tbadge";

    await agentsSetIdentityCommand({ agent: "main", name }, runtime);

    const textOutput = runtime.log.mock.calls.flat().join("\n");
    expect(textOutput).not.toContain("\u001B");
    expect(textOutput).not.toContain("\nforged-row");
    expect(textOutput).toContain("Operator🦞\\r\\nforged-row\\tbadge");
    expect(writtenAgent()?.identity).toEqual({ name });
    expect(await jsonIdentity({ agent: "main", name })).toMatchObject({
      agentId: "main",
      identity: { name },
      workspace: null,
      identityFile: null,
      storedWorkspace: expect.stringMatching(/\S/),
    });
  });

  it("reads and reports an explicit IDENTITY.md path", async () => {
    const { root, workspace } = await createIdentityWorkspace();
    const storedWorkspace = path.join(root, "stored");
    await fs.mkdir(storedWorkspace, { recursive: true });
    const identityPath = await writeIdentityFile(workspace, [
      "- **Name:** C-3PO",
      "- **Creature:** Flustered Protocol Droid",
      "- **Emoji:** 🤖",
      "- **Avatar:** avatars/c3po.png",
      "",
    ]);
    setAgents({ entries: { main: { workspace: storedWorkspace } } });
    const identity = {
      name: "C-3PO",
      theme: "Flustered Protocol Droid",
      emoji: "🤖",
      avatar: "avatars/c3po.png",
    };
    const options = { agent: "main", identityFile: identityPath };
    expect(await jsonIdentity(options)).toEqual({
      agentId: "main",
      identity,
      workspace,
      storedWorkspace,
      identityFile: identityPath,
    });

    expect(writtenAgent()).toMatchObject({ workspace: storedWorkspace, identity });
    await agentsSetIdentityCommand(options, runtime);
    expect(runtime.log).toHaveBeenCalledWith(`Workspace: ${storedWorkspace}`);
    expect(runtime.log).toHaveBeenCalledWith(`Identity source: ${workspace}`);
    expect(runtime.log.mock.calls.flat().join("\n")).not.toContain("Relocate with");
  });

  it("rejects an invalid agent id without changing config", async () => {
    const agent = "агент✨";
    await expectIdentityCommandFailure(
      { agent, name: "Ghost", json: true },
      `Agent "${agent}" not found. Create it with \`openclaw agents add\`.`,
    );
  });

  it("rejects absent main before reading its identity file", async () => {
    const agentId = "main";
    setAgents({ entries: { ops: {} } });

    await expectIdentityCommandFailure(
      { agent: agentId, identityFile: "/missing/IDENTITY.md" },
      `Agent "${agentId}" not found. Create it with \`openclaw agents add\`.`,
    );
  });

  it("errors when an explicit identity file exceeds the size cap", async () => {
    const { workspace } = await createIdentityWorkspace();
    const identityPath = await writeIdentityFile(workspace, [
      "- Name: Oversized",
      "x".repeat(TEST_MAX_IDENTITY_FILE_BYTES + 1),
    ]);

    const originalIdentity = await fs.readFile(identityPath, "utf8");
    await expectIdentityCommandFailure(
      { agent: "main", identityFile: identityPath, json: true },
      /(?=.*exceeds the maximum size of 4194304 bytes)(?=.*File exceeds 4194304 bytes:)(?=.*too-large)/s,
    );
    await expect(fs.readFile(identityPath, "utf8")).resolves.toBe(originalIdentity);
  });

  it("errors when identity data is missing", async () => {
    const { workspace } = await createIdentityWorkspace();
    setAgents({ entries: { main: { workspace } } });

    await expectIdentityCommandFailure(
      { workspace, fromIdentity: true, json: true },
      `No identity data found in ${path.join(workspace, "IDENTITY.md")}.`,
    );
    await expect(fs.access(path.join(workspace, "IDENTITY.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not persist --workspace and reports the stored workspace separately", async () => {
    const { root, workspace: storedWorkspace } = await createIdentityWorkspace("stored");
    const workspaceLocator = path.join(root, "My workspace");
    await fs.mkdir(workspaceLocator, { recursive: true });

    setAgents({ entries: { worker: { workspace: storedWorkspace } } });
    const options = { agent: "worker", workspace: workspaceLocator, name: "Worker" };
    expect(await jsonIdentity(options)).toEqual({
      agentId: "worker",
      identity: { name: "Worker" },
      workspace: workspaceLocator,
      storedWorkspace,
      identityFile: null,
    });
    expect(writtenAgent("worker")).toMatchObject({
      workspace: storedWorkspace,
      identity: { name: "Worker" },
    });
    await agentsSetIdentityCommand(options, runtime);
    expect(runtime.log).toHaveBeenCalledWith(`Workspace: ${storedWorkspace}`);
    expect(runtime.log).toHaveBeenCalledWith(`Workspace locator: ${workspaceLocator}`);
    expect(runtime.log).toHaveBeenCalledWith(
      `Stored workspace unchanged. Relocate with ${formatCliCommand(
        `openclaw config set agents.entries.worker.workspace ${quoteCliArg(workspaceLocator)}`,
      )}.`,
    );
    expect(runtime.log.mock.calls.flat().join("\n")).not.toContain("Identity source:");
  });
});

describe("agents helpers", () => {
  it("applyAgentConfig leaves a first roster entry trivially sole", async () => {
    const next = applyAgentConfig({}, { agentId: "work", name: "Work" });

    expect(next.agents?.entries).toEqual({ work: { name: "Work" } });
    expect(await buildAgentSummaries(next)).toMatchObject([{ id: "work", isDefault: true }]);
  });

  it("applyAgentConfig clears a model override", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.6-luna" } },
        entries: {
          work: { workspace: "/work-ws", model: "anthropic/claude" },
        },
      },
    };

    const next = applyAgentConfig(cfg, { agentId: "work", model: null });
    const work = next.agents?.entries?.work;

    expect(work).not.toHaveProperty("model");
    expect(await buildAgentSummaries(next)).toMatchObject([
      { id: "work", model: "openai/gpt-5.6-luna" },
    ]);
  });

  it("adds distinct routes, upgrades account scope, and reports duplicate ownership", () => {
    const existing = { agentId: "main", match: { channel: "whatsapp", accountId: "default" } };
    const channel = { agentId: "main", match: { channel: "telegram" } };
    const role = {
      agentId: "main",
      match: { channel: "discord", accountId: "guild-a", guildId: "123", roles: ["111", "222"] },
    };
    const conflict = { ...existing, agentId: "work" };
    const upgraded = { agentId: "main", match: { channel: "telegram", accountId: "work" } };
    const added: AgentRouteBinding[] = [
      { agentId: "work", match: { channel: "discord", accountId: "guild-a", guildId: "123" } },
      {
        agentId: "main",
        match: { channel: "discord", peer: { kind: "direct", id: "a|b" }, accountId: "default" },
      },
      {
        agentId: "main",
        match: {
          channel: "discord",
          peer: { kind: "direct", id: "a" },
          guildId: "b",
          accountId: "|default",
        },
      },
    ];
    const result = applyAgentBindings({ bindings: [existing, channel, role] }, [
      existing,
      conflict,
      upgraded,
      ...added,
    ]);
    expect(result.added).toStrictEqual(added);
    expect(result.skipped).toStrictEqual([existing]);
    expect(result.updated).toStrictEqual([upgraded]);
    expect(result.conflicts).toStrictEqual([{ binding: conflict, existingAgentId: "main" }]);
    expect(result.config.bindings).toStrictEqual([existing, upgraded, role, ...added]);
  });

  it("removeAgentBindings does not remove role-based bindings when removing channel-level routes", () => {
    const match = { channel: "discord", accountId: "guild-a", guildId: "123" };
    const kept = { agentId: "main", match: { ...match, roles: ["111", "222"] } };
    const removed = { agentId: "main", match };
    const result = removeAgentBindings({ bindings: [kept, removed] }, [removed]);

    expect(result.removed).toStrictEqual([removed]);
    expect(result.conflicts).toStrictEqual([]);
    expect(result.config.bindings).toEqual([kept]);
  });

  it("pruneAgentConfig removes agent, bindings, and allowlist entries", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: "/srv/fleet",
          heartbeat: { agentId: "work", every: "5m" },
          systemAgent: { agentId: "WORK" },
          subagents: { allowAgents: ["work", "home"] },
        },
        entries: {
          work: { workspace: "/work-ws" },
          home: {
            subagents: { allowAgents: ["WORK", "home"] },
            tools: { profile: "coding", agentToAgent: { send: ["WORK"] } },
          },
        },
      },
      bindings: [
        { agentId: "work", match: { channel: "whatsapp" } },
        { agentId: "home", match: { channel: "telegram" } },
      ],
      broadcast: {
        strategy: "parallel",
        "peer-1": ["work", "home"],
        "peer-2": ["WORK"],
        "telegram:-100123": { agents: ["WORK", "home"], maxRounds: 2, maxTurns: 4 },
        "slack:C0123": { agents: ["work"], mentionGating: false },
      },
      hooks: {
        allowedAgentIds: ["*", "work", "home"],
        mappings: [
          { id: "work-hook", agentId: "WORK", action: "agent" },
          { id: "home-hook", agentId: "home", action: "agent" },
          { id: "default-hook", action: "agent" },
        ],
      },
      tools: {
        agentToAgent: { enabled: true, allow: ["work", "home"] },
      },
      talk: { agentId: "work", provider: "test-provider" },
    };

    const result = pruneAgentConfig(cfg, "work");
    expect(result.config.agents?.entries).not.toHaveProperty("work");
    expect(result.config.agents?.entries?.home?.workspace).toBe("/srv/fleet/home");
    expect(result.config.bindings).toStrictEqual([
      { agentId: "home", match: { channel: "telegram" } },
    ]);
    expect(result.config.broadcast).toEqual({
      strategy: "parallel",
      "peer-1": ["home"],
      "peer-2": [],
      "telegram:-100123": { agents: ["home"], maxRounds: 2, maxTurns: 4 },
      "slack:C0123": { agents: [], mentionGating: false },
    });
    expect(result.config.hooks?.allowedAgentIds).toEqual(["*", "home"]);
    expect(result.config.hooks?.mappings).toEqual([
      { id: "home-hook", agentId: "home", action: "agent" },
      { id: "default-hook", action: "agent" },
    ]);
    expect(result.config.tools?.agentToAgent?.allow).toEqual(["home"]);
    expect(result.config.agents?.defaults?.subagents?.allowAgents).toEqual(["home"]);
    expect(result.config.agents?.defaults?.heartbeat).toEqual({ every: "5m" });
    expect(result.config.agents?.defaults?.systemAgent).toBeUndefined();
    expect(result.config.talk).toEqual({ provider: "test-provider" });
    expect(result.config.agents?.entries?.home?.subagents?.allowAgents).toEqual(["home"]);
    expect(result.config.agents?.entries?.home?.tools).toEqual({
      profile: "coding",
      agentToAgent: { send: [] },
    });
    expect(cfg.agents?.entries?.home?.tools?.agentToAgent?.send).toEqual(["WORK"]);
    expect(result.removedBindings).toBe(1);
    expect(result.removedAllow).toBe(1);
    expect(result.clearedOwnerRefs).toEqual([
      "agents.defaults.heartbeat.agentId",
      "agents.defaults.systemAgent.agentId",
      "talk.agentId",
    ]);
  });

  it("removes ambient heartbeat policy when its owner leaves a surviving fleet", () => {
    const result = pruneAgentConfig(
      {
        agents: {
          ownership: "explicit",
          defaults: { heartbeat: { agentId: "ops", every: "5m" } },
          entries: { ops: {}, research: {}, writer: {} },
        },
      },
      "ops",
    );

    expect(result.config.agents?.defaults?.heartbeat).toBeUndefined();
    expect(result.clearedOwnerRefs).toContain("agents.defaults.heartbeat");
  });
});
