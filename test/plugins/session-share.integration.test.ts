import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  sessionCatalogPaging,
  type SessionCatalogProvider,
  type SessionCatalogSession,
  type SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import sessionSharePlugin from "../../extensions/session-share/index.js";
import { setRuntimeConfigSnapshot } from "../../src/config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../src/config/sessions/session-accessor.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import { createDeferredCore } from "../../src/shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../src/state/openclaw-agent-db.js";
import * as stateReads from "../../src/state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../src/state/openclaw-state-db.js";
import { linkEmail, syncGitHubIdentity } from "../../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../src/state/user-profiles.js";

afterEach(() => vi.restoreAllMocks());

function registerSessionShare(runtime: PluginRuntime, config: OpenClawConfig = {}) {
  const nodeCommands: OpenClawPluginNodeHostCommand[] = [];
  const catalogs: SessionCatalogProvider[] = [];
  const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
  const api = createTestPluginApi({
    runtime,
    config,
    registerNodeHostCommand: (command) => nodeCommands.push(command),
    registerSessionCatalog: (catalog) => catalogs.push(catalog),
    registerService: (service) => services.push(service),
  });
  sessionSharePlugin.register(api);
  const catalog = catalogs.find((entry) => entry.id === "openclaw");
  if (!catalog) {
    throw new Error("Session Share did not register its catalog");
  }
  return { commands: nodeCommands, catalog, services, logger: api.logger };
}

type SessionPage = { sessions: SessionCatalogSession[]; nextCursor?: string };
type TranscriptPage = {
  threadId: string;
  items: SessionCatalogTranscriptItem[];
  nextCursor?: string;
};

function sessionScope(id: string) {
  return { agentId: "main", sessionKey: `agent:main:${id}`, sessionId: id };
}

async function writeSession(id: string, patch: Partial<SessionEntry> = {}) {
  const scope = sessionScope(id);
  await replaceSessionEntry(scope, {
    sessionId: id,
    updatedAt: Date.now(),
    category: "Team",
    ...patch,
  });
  return scope;
}

function profileActor(id: string) {
  return { type: "human", source: "profile", id } as const;
}

function githubProfile(accountId: number, login: string, name: string, email?: string) {
  return syncGitHubIdentity({
    identity: { accountId, login, name },
    authenticationAlias: email ? { kind: "email", email } : { kind: "github-login", login },
  });
}

function linkedActor(id: string) {
  return { type: "human", id, identity: { type: "profile", id }, label: "Catalog Person" };
}

function withCommands(run: (fixture: ReturnType<typeof commandFixture>) => Promise<void>) {
  return withOpenClawTestState({ scenario: "minimal" }, () => run(commandFixture()));
}

function expectSingleItem(items: unknown, shape: unknown) {
  expect(items).toMatchObject([shape]);
}

function commandFixture(groups: string[] = ["Team"]) {
  const config: OpenClawConfig = {
    plugins: { entries: { "session-share": { enabled: true, config: { share: { groups } } } } },
  };
  setRuntimeConfigSnapshot(config);
  const runtime = createPluginRuntime();
  runtime.config.current = () => config;
  const commands = registerSessionShare(runtime, config).commands;
  const list = commands.find((command) => command.command === "openclaw.sessions.list.v1")!;
  const read = commands.find((command) => command.command === "openclaw.sessions.read.v1")!;
  return {
    config,
    commands,
    list: async (params: Record<string, unknown> = {}) =>
      JSON.parse(await list.handle(JSON.stringify(params))) as SessionPage,
    read: async (threadId: string, params: Record<string, unknown> = {}) =>
      JSON.parse(await read.handle(JSON.stringify({ threadId, ...params }))) as TranscriptPage,
  };
}

const commands = ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"];
const nativeSession: SessionCatalogSession = {
  threadId: "agent:main:shared",
  name: "Shared session",
  status: "idle",
  archived: false,
  canContinue: false,
  canArchive: false,
  canOpenTerminal: false,
};
const remoteIdentity = {
  type: "remote" as const,
  pluginId: "session-share",
  domain: "source",
  idKind: "github-account",
  id: "4242",
};

function remoteHuman(threadId: string, id = "4242", domain = remoteIdentity.domain) {
  return {
    ...nativeSession,
    threadId,
    createdActor: {
      type: "human" as const,
      id,
      identity: { ...remoteIdentity, id, domain },
      label: "Remote Person",
    },
  };
}

function nodeConfig(
  nodes: Record<string, { owner?: string; linkGitHubIdentities?: boolean }>,
): OpenClawConfig {
  return { plugins: { entries: { "session-share": { config: { nodes } } } } };
}

function publishedActor(id: string, label: string, idKind = "github-account") {
  return {
    type: "human",
    id,
    label,
    identity: { type: "remote", pluginId: "session-share", domain: "openclaw", idKind, id },
  };
}

function holdStateRead() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const execute = stateReads.executeExistingOpenClawStateRead;
  vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementationOnce(
    async (...args) => {
      const result = await execute(...args);
      entered.resolve();
      await release.promise;
      return result;
    },
  );
  return { entered: entered.promise, release: () => release.resolve() };
}

describe("session-share node commands", () => {
  it("refreshes shared metadata and visibility after source writes", async () => {
    await withCommands(async (source) => {
      expect((await source.list()).sessions).toEqual([]);
      const scope = await writeSession("shared-cache", { label: "Original" });
      await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: { role: "user", content: "Shared question" },
      });
      expectSingleItem((await source.read(scope.sessionKey)).items, {
        type: "userMessage",
        text: "Shared question",
      });
      expect((await source.list()).sessions).toMatchObject([{ name: "Original" }]);
      await upsertSessionEntryCore(scope, { label: "Renamed" });
      expect((await source.list()).sessions).toMatchObject([{ name: "Renamed" }]);
      await upsertSessionEntryCore(scope, { category: "Private" });
      expect((await source.list()).sessions).toEqual([]);
      await expect(source.read(scope.sessionKey)).rejects.toThrow("not shared");
      await writeSession("shared-cache", { sessionId: "replacement", label: "Original" });
      expect((await source.list()).sessions).toMatchObject([{ name: "Original" }]);
    });
  });

  it("derives paged transcript titles and searches titles and session keys", async () => {
    await withCommands(async (source) => {
      const named = { threadId: "agent:main:named", name: "Named session" };
      const derived = { threadId: "agent:main:derived", name: "Derived title" };
      const scope = await writeSession("derived");
      await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: { role: "user", content: derived.name },
      });
      await writeSession("named", { updatedAt: Date.now() + 1, label: named.name });
      const { db } = openOpenClawAgentDatabase({ agentId: "main" });
      const first = await source.list({ limit: 1 });
      expectSingleItem(first.sessions, named);
      expect(first.nextCursor).toBeDefined();
      const last = await source.list({ limit: 2, cursor: first.nextCursor });
      expectSingleItem(last.sessions, derived);
      expect(last.nextCursor).toBeUndefined();
      for (const searchTerm of ["Derived title", "MAIN:DERIVED"]) {
        expectSingleItem((await source.list({ searchTerm, limit: 1 })).sessions, derived);
      }
      db.prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ?").run(
        "invalid-json",
        "derived",
      );
      expectSingleItem((await source.list({ limit: 1 })).sessions, named);
      await expect(
        source.list({ limit: 1, cursor: sessionCatalogPaging.encodeCursor(1) }),
      ).rejects.toThrow(SyntaxError);
    });
  });

  it.each(["fixed", "template"])(
    "reads the configured %s store and revokes an in-flight read when its store changes",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const fixture = commandFixture();
        const store =
          kind === "template"
            ? state.path("configured", "{agentId}", "sessions.json")
            : state.path("configured", "sessions.json");
        const configuredStorePath = resolveStorePath(store, { agentId: "main" });
        const defaultStorePath = resolveStorePath(undefined, { agentId: "main" });
        const scope = { ...sessionScope("configured"), sessionId: "configured-session" };
        for (const [storePath, text] of [
          [defaultStorePath, "Default store copy"],
          [configuredStorePath, "Configured store question"],
        ]) {
          await replaceSessionEntry(
            { ...scope, storePath },
            { sessionId: scope.sessionId, updatedAt: Date.now(), category: "Team" },
          );
          await appendSessionTranscriptMessageByIdentity({
            ...scope,
            storePath,
            message: { role: "user", content: text },
          });
        }
        fixture.config.session = { store };
        expect
          .soft((await fixture.list()).sessions)
          .toMatchObject([{ threadId: scope.sessionKey, name: "Configured store question" }]);
        expect
          .soft((await fixture.read(scope.sessionKey)).items)
          .toMatchObject([{ type: "userMessage", text: "Configured store question" }]);

        const pendingRead = fixture.read(scope.sessionKey);
        fixture.config.session = { store: defaultStorePath };
        await expect(pendingRead).rejects.toThrow("no longer shared");

        fixture.config.session = { store };
        await upsertSessionEntryCore(
          { ...scope, storePath: configuredStorePath },
          { category: "Private" },
        );
        expect((await fixture.list()).sessions).toEqual([]);
        await expect(fixture.read(scope.sessionKey)).rejects.toThrow("not shared");
      });
    },
  );

  it("publishes selected root sessions while denying grouped subagents, with stable paging", async () => {
    await withCommands(async (fixture) => {
      // Keep the tied fixture fresh: subsequent writes prune ancient unarchived sessions.
      const recency = Date.now();
      for (const [key, patch] of [
        [
          "alpha",
          {
            label: "Alpha",
            updatedAt: recency,
            execCwd: "/work/alpha",
            spawnedCwd: "/work/ignored",
            parentSessionKey: "agent:main:parent",
            spawnDepth: 0,
          },
        ],
        [
          "beta",
          {
            label: "Beta",
            updatedAt: recency,
            archivedAt: recency - 1,
            worktree: { id: "beta-worktree", repoRoot: "/work/beta", branch: "b".repeat(6010) },
          },
        ],
        ["private", { category: "Other" }],
        ["draft", { visibility: "draft" }],
        ["incognito", { incognito: true }],
        ["catalog:external", {}],
        ["subagent:key-only", {}],
        ["dashboard:spawn-owned", { createdVia: "spawn" }],
        ["acp:resumed-child", { spawnedBy: "agent:main:main", spawnDepth: 1 }],
        ["main", { updatedAt: recency - 1 }],
        ["cron:job:run:root", { updatedAt: recency - 1, createdVia: "cron" }],
      ] as const) {
        await writeSession(key, { updatedAt: recency + 1, ...patch });
      }
      for (const key of ["subagent:key-only", "dashboard:spawn-owned", "acp:resumed-child"]) {
        await expect.soft(fixture.read(`agent:main:${key}`)).rejects.toThrow("not shared");
      }
      let cursor: string | undefined;
      for (const [key, name, details] of [
        ["alpha", "Alpha", {}],
        ["beta", "Beta", { gitBranch: "b".repeat(6000), archived: true, status: "archived" }],
      ] as const) {
        const page = await fixture.list({ limit: 1, cursor });
        expect(page.sessions).toEqual([
          {
            ...nativeSession,
            threadId: `agent:main:${key}`,
            name,
            cwd: `/work/${key}`,
            updatedAt: recency,
            recencyAt: recency,
            ...details,
          },
        ]);
        expect(page.nextCursor).toBeDefined();
        cursor = page.nextCursor;
      }
      const roots = await fixture.list({ cursor });
      expect(roots.sessions.map((session) => session.threadId)).toEqual([
        "agent:main:cron:job:run:root",
        "agent:main:main",
      ]);
      expect(roots.nextCursor).toBeUndefined();
      for (const key of ["private", "draft", "incognito", "catalog:external"]) {
        await expect(fixture.read(`agent:main:${key}`)).rejects.toThrow("not shared");
      }
      await expect(fixture.list({ cursor: "invalid" })).rejects.toThrow();
      await expect(fixture.list({ unexpected: true })).rejects.toThrow("Unknown");
    });
  });

  it("batches distinct and repeated creators without mixing labels or retaining facts across requests", async () => {
    await withCommands(async (fixture) => {
      const creator = githubProfile(4242, "original", "Original", "creator@example.test");
      const target = githubProfile(4343, "merged-person", "Merged Person", "target@example.test");
      const distinct = githubProfile(5000, "distinct", "Distinct");
      const actor = profileActor(creator.id);
      const actors = [
        actor,
        actor,
        profileActor(distinct.id),
        { type: "human", source: "profile", id: "missing", label: "First fallback" },
        { type: "human", source: "profile", id: "missing", label: "Second fallback" },
        { type: "human", source: "channel", id: creator.id, label: "Channel person" },
        { type: "agent", id: creator.id, label: "Agent" },
      ] as const;
      const now = Date.now();
      for (const [index, createdActor] of actors.entries()) {
        await writeSession(`creator-${index}`, {
          updatedAt: now - index,
          label: `Session ${index}`,
          createdActor,
        });
      }
      const first = await fixture.list();
      expect(first.sessions.map((session) => session.createdActor)).toEqual([
        publishedActor("4242", "Original"),
        publishedActor("4242", "Original"),
        publishedActor("5000", "Distinct"),
        ...["First fallback", "Second fallback"].map((label) =>
          publishedActor("missing", label, "profile"),
        ),
        { type: "human", id: creator.id, label: "Channel person" },
        { type: "agent", id: creator.id, label: "Agent" },
      ]);
      linkEmail("creator@example.test", target.id);
      const refreshed = await fixture.list();
      expect(refreshed.sessions.slice(0, 2).map((session) => session.createdActor)).toEqual(
        Array.from({ length: 2 }, () => publishedActor("4343", "Merged Person")),
      );
      expect(refreshed.sessions.slice(2)).toEqual(first.sessions.slice(2));
      openOpenClawStateDatabase()
        .db.prepare("UPDATE user_profiles SET primary_github_account_id = ? WHERE id = ?")
        .run(9007199254740992n, target.id);
      await expect(fixture.list({ limit: 1 })).rejects.toThrow(RangeError);
      const tail = await fixture.list({ cursor: sessionCatalogPaging.encodeCursor(2) });
      expect(tail.sessions).toEqual(first.sessions.slice(2));
    });
  });

  it.each(["list", "read"] as const)(
    "refuses a replaced physical source during %s identity preparation",
    async (operation) => {
      await withCommands(async (fixture) => {
        const profile = ensureProfileForEmail("physical@example.test");
        const scope = await writeSession("physical", {
          label: "Shared",
          createdActor: profileActor(profile.id),
        });
        await appendSessionTranscriptMessageByIdentity({
          ...scope,
          message: {
            role: "user",
            content: "Shared",
            __openclaw: { senderIdentity: { type: "profile", id: profile.id } },
          },
        });
        const pathname = openOpenClawAgentDatabase({ agentId: "main" }).path;
        const gate = holdStateRead();
        const pending = operation === "list" ? fixture.list() : fixture.read(scope.sessionKey);
        try {
          await Promise.race([
            gate.entered,
            pending.then(() => {
              throw new Error("Read was not held");
            }),
          ]);
          await closeOpenClawAgentDatabasesAsync();
          fs.renameSync(pathname, `${pathname}.previous`);
          fs.copyFileSync(`${pathname}.previous`, pathname);
        } finally {
          gate.release();
        }
        await expect(pending).rejects.toThrow();
      });
    },
  );

  it("does not advertise or publish without share configuration", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = commandFixture([]);
      fixture.config.plugins = undefined;
      const manifest = JSON.parse(
        fs.readFileSync(
          new URL("../../extensions/session-share/openclaw.plugin.json", import.meta.url),
          "utf8",
        ),
      ) as { configSchema: Record<string, unknown> };
      expect(
        validateJsonSchemaValue({
          schema: manifest.configSchema,
          cacheKey: "session-share.disabled-config",
          value: {},
        }).ok,
      ).toBe(true);
      for (const command of fixture.commands) {
        expect(command.isAvailable?.({ config: fixture.config, env: {} })).toBe(false);
      }
      expect((await fixture.list()).sessions).toEqual([]);
      await expect(fixture.read("agent:main:unshared")).rejects.toThrow("not shared");
    });
  });
});

describe("session-share receiver identity integration", () => {
  it("keeps claims remote by default and applies only explicit owner and numeric GitHub links", async () => {
    const nodeId = "alpha";
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      vi.useFakeTimers();
      let config: OpenClawConfig = {};
      const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>();
      const runtime = createPluginRuntimeMock({
        config: { current: () => config },
        nodes: { list: async () => ({ nodes: [{ nodeId, connected: true, commands }] }), invoke },
      });
      const { catalog, services, logger } = registerSessionShare(runtime);
      const scheduler = createTestPluginServiceScheduler();
      const context = { config, stateDir: state.stateDir, logger, invokeNode: invoke, scheduler };
      const refresh = async () => {
        const page = catalog.list({});
        void page.catch(() => {});
        await vi.advanceTimersByTimeAsync(2);
        return (await page)[0]!.sessions;
      };
      try {
        await Promise.all(services.map(async (service) => await service.start(context)));
        const profile = githubProfile(4242, "catalog-person", "Catalog Person");
        const hostId = `node:${nodeId}`;
        const namespacedIdentity = { ...remoteIdentity, domain: hostId };
        const human = remoteHuman(nativeSession.threadId);
        const agent = {
          ...nativeSession,
          threadId: "agent:main:agent",
          createdActor: { type: "agent" as const, id: "assistant", label: "Assistant" },
        };
        const unmatched = remoteHuman("agent:main:unmatched", "9999");
        const transcript = {
          threadId: nativeSession.threadId,
          items: [remoteIdentity, remoteIdentity, { ...remoteIdentity, id: "9999" }].map(
            (identity) => ({
              type: "userMessage",
              text: "Question",
              sender: { identity, label: "Remote Person" },
            }),
          ),
        };
        invoke.mockImplementation(async ({ command }) =>
          command === commands[0] ? { sessions: [human, agent, unmatched] } : transcript,
        );
        const namespacedHuman = remoteHuman(human.threadId, "4242", hostId);
        const namespacedUnmatched = remoteHuman(unmatched.threadId, "9999", hostId);
        expect(await refresh()).toEqual([namespacedHuman, agent, namespacedUnmatched]);
        expect(
          (await catalog.read({ hostId, threadId: nativeSession.threadId })).items[0]?.sender
            ?.identity,
        ).toEqual(namespacedIdentity);
        for (const identityConfig of [
          { owner: `profile:${profile.id}` },
          { owner: "github:CATALOG-PERSON" },
          { linkGitHubIdentities: true },
        ]) {
          const linksHumans = "linkGitHubIdentities" in identityConfig;
          config = nodeConfig({ [nodeId]: identityConfig });
          const rows = await refresh();
          expect(rows[linksHumans ? 0 : 1]?.createdActor).toMatchObject(linkedActor(profile.id));
          expect(rows[linksHumans ? 1 : 0]).toEqual(linksHumans ? agent : namespacedHuman);
          expect(rows[2]).toEqual(namespacedUnmatched);
        }
        const page = await catalog.read({ hostId, threadId: nativeSession.threadId });
        expect(page.items.map((item) => item.sender)).toEqual([
          { identity: { type: "profile", id: profile.id }, label: "Catalog Person" },
          { identity: { type: "profile", id: profile.id }, label: "Catalog Person" },
          { identity: { ...namespacedIdentity, id: "9999" }, label: "Remote Person" },
        ]);
      } finally {
        scheduler.beginClose();
        try {
          await Promise.all(services.map(async (service) => await service.stop?.(context)));
        } finally {
          await scheduler.stop().finally(() => vi.useRealTimers());
        }
      }
    });
  });
});
