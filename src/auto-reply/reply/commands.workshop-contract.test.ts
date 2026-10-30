import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { closeSkillsWatchers } from "../../skills/runtime/refresh.js";
import { historicalWorkshopChangesSchema } from "../../skills/test-support/workshop-schema.test-support.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { CommandDispatchParams } from "./commands-types.js";
import { handleCommands } from "./commands.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

const REVIEW_ID = "0b6a4a52-1f43-4f0e-9d55-3c1d8e1f7a10";
const SAVED_VERSION = "20260101T000000000Z-patch";
const UNAVAILABLE =
  "Skill workshop is not available on this agent. Use a non-sandboxed agent where the skill_workshop tool is available, or use the openclaw skills workshop CLI.";
const ORIGINAL =
  "---\nname: deploy\ndescription: Deploy staging builds\n---\n\nRun the staging checks.\n";
const UPDATED = ORIGINAL.replace("staging checks", "staging checks and smoke tests");
const CREATED = "---\nname: release\ndescription: Release builds\n---\n\nPublish the build.\n";

let state: OpenClawTestState;
let registry: PluginRegistry;

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "home" });
  registry = createEmptyPluginRegistry();
});

afterEach(async () => {
  await closeSkillsWatchers(true);
  await closeStateDatabaseForTest();
  await state.cleanup();
});

function paramsFor(body: string): CommandDispatchParams {
  const cfg: OpenClawConfig = {
    commands: { text: true },
    agents: {
      defaults: { workspace: state.workspaceDir },
      entries: { main: { sandbox: { mode: "off" } } },
    },
    skills: { load: { watch: false } },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          models: [
            {
              id: "gpt-5.5",
              name: "GPT-5.5",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 16_384,
              compat: { supportsTools: true },
            },
          ],
        },
      },
    },
  };
  const ctx = {
    Provider: INTERNAL_MESSAGE_CHANNEL,
    Surface: INTERNAL_MESSAGE_CHANNEL,
    CommandSource: "text" as const,
    Body: body,
    RawBody: body,
    CommandBody: body,
    BodyForCommands: body,
    BodyForAgent: body,
    BodyStripped: body,
  };
  return {
    cfg,
    ctx,
    rootCtx: { ...ctx },
    command: {
      commandBodyNormalized: body,
      rawBodyNormalized: body,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "contract-owner",
      channel: INTERNAL_MESSAGE_CHANNEL,
      surface: INTERNAL_MESSAGE_CHANNEL,
      ownerList: [],
    },
    directives: parseInlineSessionDirectives(""),
    elevated: { enabled: true, allowed: true, failures: [] },
    agentId: "main",
    agentDir: state.agentDir(),
    sessionKey: "agent:main:webchat:workshop-contract",
    workspaceDir: state.workspaceDir,
    provider: "openai",
    model: "gpt-5.5",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    resolveModelLevels: async () => ({
      resolvedThinkLevel: undefined,
      resolvedReasoningLevel: "off",
    }),
    isGroup: false,
    skillCommands: [],
  };
}

function dispatch(params: CommandDispatchParams) {
  return withPluginRuntimeRegistryScope(registry, () => handleCommands(params));
}

function expectRewritten(params: CommandDispatchParams, request: string) {
  const prompt = params.ctx.BodyForAgent;
  // Pin how the request reaches the agent; the guidance wording below it belongs to Workshop.
  expect(prompt?.split("\n").slice(0, 2)).toEqual([
    "The user asked you to learn a skill.",
    `Learning request (JSON string): ${JSON.stringify(request)}`,
  ]);
  expect(prompt).toContain("Write with skill_workshop");
  for (const ctx of [params.ctx, params.rootCtx]) {
    expect(ctx).toMatchObject({
      commandText: prompt,
      agentText: prompt,
      rawText: prompt,
      Body: prompt,
      RawBody: prompt,
      CommandBody: prompt,
      BodyForCommands: prompt,
      BodyForAgent: prompt,
      BodyStripped: prompt,
    });
  }
  expect(params.command.commandBodyNormalized).toBe(prompt);
  expect(params.command.rawBodyNormalized).toBe(prompt);
}

const workshopRoot = () => path.join(state.agentDir(), "workshop-skills");

async function withRawDatabase<T>(read: (db: DatabaseSync) => T): Promise<T> {
  await closeSkillsWatchers(true);
  await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
  await closeStateDatabaseForTest();
  const db = new DatabaseSync(resolveOpenClawStateSqlitePath());
  try {
    db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    return read(db);
  } finally {
    db.close();
  }
}

async function seedReview() {
  await state.writeText("agents/main/agent/workshop-skills/deploy/SKILL.md", UPDATED);
  await state.writeText("agents/main/agent/workshop-skills/release/SKILL.md", CREATED);
  await state.writeText(
    `agents/main/agent/workshop-skills/.archive/deploy/${SAVED_VERSION}/SKILL.md`,
    ORIGINAL,
  );
  // Bootstrap the surviving core schema owner, then write a historical persisted feed offline.
  openOpenClawStateDatabase();
  await withRawDatabase((db) => {
    db.exec(historicalWorkshopChangesSchema);
    const insert = db.prepare(
      `INSERT INTO skill_workshop_changes
       (cursor_id, change_id, agent_id, skill_name, action, actor, summary, version_id,
        session_key, run_id, created_at_ms) VALUES (?, ?, 'main', ?, ?, 'review', ?, ?, ?, ?, ?)`,
    );
    insert.run(
      1,
      "review-deploy",
      "deploy",
      "patch",
      "added smoke checks",
      SAVED_VERSION,
      "agent:main:webchat:reviewed",
      `skill-workshop-review:${REVIEW_ID}`,
      1,
    );
    insert.run(
      2,
      "review-release",
      "release",
      "create",
      "created release",
      null,
      "agent:main:webchat:reviewed",
      `skill-workshop-review:${REVIEW_ID}`,
      2,
    );
    db.exec("COMMIT");
  });
}

async function readChanges() {
  return withRawDatabase((db) =>
    db
      .prepare(
        `SELECT skill_name, action, actor, summary, session_key, run_id
         FROM skill_workshop_changes ORDER BY cursor_id`,
      )
      .all(),
  );
}

describe("/learn through the command registry", () => {
  it.each([
    ["/learn", "Save the reusable workflow from what we just did as a skill."],
    [
      '/learn Read notes/incident.md and save the "deploy" workflow.',
      'Read notes/incident.md and save the "deploy" workflow.',
    ],
  ])("rewrites %s into a continuing authoring turn", async (body, request) => {
    const params = paramsFor(body);
    // Authoring requests are available to authorized senders, not only owners.
    params.command.senderIsOwner = false;
    expect(await dispatch(params)).toEqual({ shouldContinue: true });
    expectRewritten(params, request);
  });

  it.each([
    {
      name: "disabled tools",
      configure: (p: CommandDispatchParams) => {
        p.opts = { disableTools: true };
      },
    },
    {
      name: "empty runtime allowlist",
      configure: (p: CommandDispatchParams) => {
        p.opts = { toolsAllow: [] };
      },
    },
    {
      name: "runtime allowlist excludes Workshop",
      configure: (p: CommandDispatchParams) => {
        p.opts = { toolsAllow: ["read"] };
      },
    },
    {
      name: "sandbox",
      configure: (p: CommandDispatchParams) => {
        p.cfg.agents!.entries!.main!.sandbox = { mode: "all" };
      },
    },
    {
      name: "policy denial",
      configure: (p: CommandDispatchParams) => {
        p.cfg.tools = { deny: ["skill_workshop"] };
      },
    },
    {
      name: "model without tools",
      configure: (p: CommandDispatchParams) => {
        p.cfg.models!.providers!.openai!.models[0]!.compat = { supportsTools: false };
      },
    },
  ])("refuses $name without rewriting the turn", async ({ configure }) => {
    const params = paramsFor("/learn capture this workflow");
    const before = structuredClone(params.ctx);
    configure(params);
    expect(await dispatch(params)).toMatchObject({
      shouldContinue: false,
      reply: { text: UNAVAILABLE },
    });
    expect(params.ctx).toEqual(before);
    expect(params.rootCtx).toEqual(before);
    expect(params.command.commandBodyNormalized).toBe("/learn capture this workflow");
  });

  it.each([false, true])("refuses a CLI backend with node placement=%s", async (nodePlaced) => {
    registry.cliBackends.push({
      pluginId: "contract-cli",
      source: "contract",
      backend: {
        id: "claude-cli",
        modelProvider: "openai",
        config: { command: "not-executed" },
        bundleMcp: nodePlaced,
      },
    });
    const params = paramsFor("/learn");
    params.sessionEntry = {
      sessionId: "contract-session",
      updatedAt: 1,
      agentRuntimeOverride: "claude-cli",
      ...(nodePlaced ? { execHost: "node", execNode: "contract-node" } : {}),
    };
    expect(await dispatch(params)).toMatchObject({
      shouldContinue: false,
      reply: { text: UNAVAILABLE },
    });
    expect(params.ctx.BodyForAgent).toBe("/learn");
  });

  it("refuses a selected harness that does not expose OpenClaw tools", async () => {
    const runAttempt = vi.fn();
    registry.agentHarnesses.push({
      pluginId: "contract-native",
      source: "contract",
      harness: {
        id: "contract-native",
        label: "Native contract harness",
        supports: () => ({ supported: true }),
        runAttempt,
      },
    });
    const params = paramsFor("/learn");
    params.cfg.agents!.defaults!.models = {
      "openai/gpt-5.5": { agentRuntime: { id: "contract-native" } },
    };
    expect(await dispatch(params)).toMatchObject({
      shouldContinue: false,
      reply: { text: UNAVAILABLE },
    });
    expect(params.ctx.BodyForAgent).toBe("/learn");
    expect(runAttempt).not.toHaveBeenCalled();
  });

  it.each([
    "/learn undo",
    "/learn undo not-a-uuid",
    `/learn undo ${REVIEW_ID} extra`,
    `/learn undo ${REVIEW_ID.slice(0, -1)}`,
  ])("keeps the non-exact undo form %s as an authoring request", async (body) => {
    const params = paramsFor(body);
    params.command.senderIsOwner = false;
    params.ctx.GatewayClientScopes = ["operator.read"];
    expect(await dispatch(params)).toEqual({ shouldContinue: true });
    expectRewritten(params, body.slice("/learn ".length));
  });

  describe("with the selected memory plugin's learning tools", () => {
    const MEMORY_GUIDANCE = "Memory: save facts with memory_save.";
    const builds: Array<ReadonlySet<string>> = [];
    beforeEach(() => {
      builds.length = 0;
      registry.memoryCapabilities.push({
        pluginId: "contract-memory",
        memorySlotSelected: true,
        capability: {
          learnToolNames: ["memory_save"],
          learnGuidanceBuilder: ({ availableTools }) => {
            builds.push(availableTools);
            return [MEMORY_GUIDANCE];
          },
        },
      });
    });

    it("routes one /learn turn to both skills and memory", async () => {
      const params = paramsFor("/learn remember the deploy steps");
      expect(await dispatch(params)).toEqual({ shouldContinue: true });
      const prompt = params.ctx.BodyForAgent ?? "";
      expect(prompt.split("\n").slice(0, 2)).toEqual([
        "The user asked you to learn.",
        `Learning request (JSON string): ${JSON.stringify("remember the deploy steps")}`,
      ]);
      expect(prompt).toContain("Write skills with skill_workshop");
      expect(prompt).toContain(MEMORY_GUIDANCE);
      expect(builds).toEqual([new Set(["memory_save"])]);
    });

    it("learns into memory alone when policy hides skill_workshop", async () => {
      const params = paramsFor("/learn remember the deploy steps");
      params.cfg.tools = { deny: ["skill_workshop"] };
      expect(await dispatch(params)).toEqual({ shouldContinue: true });
      const prompt = params.ctx.BodyForAgent ?? "";
      expect(prompt.split("\n").slice(0, 2)).toEqual([
        "The user asked you to learn.",
        `Learning request (JSON string): ${JSON.stringify("remember the deploy steps")}`,
      ]);
      expect(prompt).toContain(MEMORY_GUIDANCE);
      expect(prompt).not.toContain("skill_workshop");
    });

    it("refuses with the combined reply when policy hides both", async () => {
      const params = paramsFor("/learn remember the deploy steps");
      params.cfg.tools = { deny: ["skill_workshop", "memory_save"] };
      expect(await dispatch(params)).toMatchObject({
        shouldContinue: false,
        reply: {
          text: "/learn can't save anything on this agent: neither the skill_workshop tool nor the memory plugin's learning tools are available here. They need a non-sandboxed session, a model and harness with tool support, and a tool policy that allows them.",
        },
      });
      expect(params.ctx.BodyForAgent).toBe("/learn remember the deploy steps");
    });
  });

  describe("/learn drafts", () => {
    async function draft(id: string, name: string) {
      const dir = path.join(state.agentDir(), "workshop-skills", ".drafts", id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: Drafted ${name}\n---\n\nDrafted step.\n`,
      );
    }

    it("answers without a model turn when no drafts wait", async () => {
      const params = paramsFor("/learn drafts");
      expect(await dispatch(params)).toMatchObject({
        shouldContinue: false,
        reply: { text: "No Skill Workshop drafts are waiting for review." },
      });
      expect(params.ctx.BodyForAgent).toBe("/learn drafts");
    });

    it.each([
      ["/learn drafts", ["deploy", "release"], undefined],
      [
        "/learn drafts deploy keep only the rollback step",
        ["deploy"],
        "keep only the rollback step",
      ],
      ["/learn drafts: be strict", ["deploy", "release"], "be strict"],
    ])("rewrites %s into a review of the selected drafts", async (body, skills, focus) => {
      await draft("deploy-1a2b3c4d", "deploy");
      await draft("release-5e6f7a8b", "release");
      const params = paramsFor(body);
      expect(await dispatch(params)).toEqual({ shouldContinue: true });
      const lines = (params.ctx.BodyForAgent ?? "").split("\n");
      expect(lines[0]).toBe(
        "The user asked you to review Skill Workshop drafts: changes background reviews proposed but did not apply.",
      );
      const listed = JSON.parse(
        /^Drafts to review \(JSON\): (.*)\. Review only these\.$/.exec(lines[1] ?? "")?.[1] ?? "[]",
      ) as Array<{ id: string; skill: string }>;
      expect(listed.map((entry) => entry.skill).toSorted()).toEqual(skills);
      expect(lines[2]).toBe(
        focus === undefined ? "" : `User focus (JSON string): ${JSON.stringify(focus)}`,
      );
      expect(params.ctx.BodyForAgent).toContain("skill_workshop action=view draft=<id>");
    });
  });

  it("does not interpret /learning as /learn", async () => {
    const params = paramsFor("/learning save this");
    expect(await dispatch(params)).toEqual({ shouldContinue: true });
    expect(params.ctx.BodyForAgent).toBe("/learning save this");
  });
});

describe("/learn undo through the command registry and persisted state", () => {
  it.each([
    { client: "Gateway admin", scopes: ["operator.admin"] },
    { client: "non-Gateway owner", scopes: undefined },
  ])(
    "restores and archives for $client, normalizes UUID case, and makes a repeat idempotent",
    async ({ scopes }) => {
      await seedReview();
      const params = paramsFor(`/learn undo ${REVIEW_ID.toUpperCase()}`);
      params.ctx.GatewayClientScopes = scopes;
      // Undo is a direct owner operation; authoring-tool availability must not block it.
      params.opts = { disableTools: true };
      expect(await dispatch(params)).toMatchObject({
        shouldContinue: false,
        reply: { text: "↩️ Undid the skill change: restored `deploy`; archived `release`." },
      });
      expect(await fs.readFile(path.join(workshopRoot(), "deploy/SKILL.md"), "utf8")).toBe(
        ORIGINAL,
      );
      await expect(fs.stat(path.join(workshopRoot(), "release/SKILL.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const archive = path.join(workshopRoot(), ".archive/release");
      const archivedVersions = await fs.readdir(archive);
      expect(archivedVersions).toHaveLength(1);
      expect(await fs.readFile(path.join(archive, archivedVersions[0]!, "SKILL.md"), "utf8")).toBe(
        CREATED,
      );
      const changes = await readChanges();
      expect(changes.slice(2)).toEqual([
        {
          skill_name: "deploy",
          action: "restore",
          actor: "user",
          summary: "undid background review",
          session_key: params.sessionKey,
          run_id: `skill-workshop-undo:${REVIEW_ID}`,
        },
        {
          skill_name: "release",
          action: "archive",
          actor: "user",
          summary: "archived: undo",
          session_key: params.sessionKey,
          run_id: `skill-workshop-undo:${REVIEW_ID}`,
        },
      ]);
      expect(await dispatch(params)).toMatchObject({
        shouldContinue: false,
        reply: { text: "That skill change was already undone." },
      });
      expect(await readChanges()).toEqual(changes);
    },
  );

  it.each([
    {
      name: "non-owner even with admin scope",
      owner: false,
      authorized: true,
      scopes: ["operator.admin"],
      text: "You are not authorized to use this owner-only command. Ask the operator to grant this Gateway client operator.admin access.",
    },
    {
      name: "unauthorized sender",
      owner: false,
      authorized: false,
      scopes: ["operator.admin"],
      text: undefined,
    },
    {
      name: "owner with write but not admin",
      owner: true,
      authorized: true,
      scopes: ["operator.write"],
      text: "❌ /learn undo requires operator.admin for gateway clients.",
    },
    {
      name: "owner with no Gateway scopes",
      owner: true,
      authorized: true,
      scopes: [],
      text: "❌ /learn undo requires operator.admin for gateway clients.",
    },
  ])(
    "refuses $name without changing persisted skills or feed",
    async ({ owner, authorized, scopes, text }) => {
      await seedReview();
      const before = await readChanges();
      const params = paramsFor(`/learn undo ${REVIEW_ID}`);
      params.command.senderIsOwner = owner;
      params.command.isAuthorizedSender = authorized;
      params.ctx.GatewayClientScopes = scopes;
      const result = await dispatch(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toBe(text);
      expect(await readChanges()).toEqual(before);
      expect(await fs.readFile(path.join(workshopRoot(), "deploy/SKILL.md"), "utf8")).toBe(UPDATED);
      expect(await fs.readFile(path.join(workshopRoot(), "release/SKILL.md"), "utf8")).toBe(
        CREATED,
      );
    },
  );

  it("answers an unknown UUID without continuing to the model", async () => {
    await seedReview();
    const before = await readChanges();
    const params = paramsFor("/learn undo 11111111-1111-4111-8111-111111111111");
    expect(await dispatch(params)).toMatchObject({
      shouldContinue: false,
      reply: { text: "No skill change found for that id." },
    });
    expect(await readChanges()).toEqual(before);
  });

  it("surfaces a missing saved version and refuses all writes", async () => {
    await seedReview();
    await fs.rm(path.join(workshopRoot(), ".archive/deploy"), { recursive: true });
    const before = await readChanges();
    expect(await dispatch(paramsFor(`/learn undo ${REVIEW_ID}`))).toMatchObject({
      shouldContinue: false,
      reply: {
        text: `⚠️ Cannot undo review ${REVIEW_ID}: the version of "deploy" saved before it is no longer kept. Restore that skill from the Skill Workshop.`,
      },
    });
    expect(await readChanges()).toEqual(before);
    expect(await fs.readFile(path.join(workshopRoot(), "deploy/SKILL.md"), "utf8")).toBe(UPDATED);
    expect(await fs.readFile(path.join(workshopRoot(), "release/SKILL.md"), "utf8")).toBe(CREATED);
  });
});
