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
import * as githubIdentities from "../../src/state/user-profile-github-identity.js";
import { linkEmail, syncGitHubIdentity } from "../../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../src/state/user-profiles.js";
import { requireNativeSqliteDatabase } from "../../src/test-utils/native-sqlite.js";
import { trackSqliteStatementExecutions } from "../helpers/sqlite-statement-execution-counter.js";

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

async function writeProfileSession(id: string, profileId: string, updatedAt = Date.now()) {
  const scope = sessionScope(id);
  await upsertSessionEntryCore(scope, {
    sessionId: id,
    updatedAt,
    label: "Shared",
    category: "Team",
    createdActor: profileActor(profileId),
  });
  return {
    scope,
    appendUser: (content: string, timestamp?: number) =>
      appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: {
          role: "user",
          content,
          timestamp,
          __openclaw: { senderIdentity: { type: "profile", id: profileId } },
        },
      }),
  };
}

function withCommands(run: (fixture: ReturnType<typeof commandFixture>) => Promise<void>) {
  return withOpenClawTestState({ scenario: "minimal" }, () => run(commandFixture()));
}

function expectSingleItem(items: unknown, shape: unknown) {
  expect(items).toMatchObject([shape]);
}

function sqlCounter(
  db: Parameters<typeof requireNativeSqliteDatabase>[0],
  rules: Record<string, RegExp[]>,
) {
  return trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(db),
    Object.keys(rules),
    (sql) =>
      Object.entries(rules).find(([, patterns]) => patterns.every((re) => re.test(sql)))?.[0] ??
      null,
  );
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

function catalogFixture(stateDir: string) {
  let config: OpenClawConfig = {};
  const list = vi.fn<PluginRuntime["nodes"]["list"]>().mockResolvedValue({
    nodes: [{ nodeId: "alpha", displayName: " Alpha ", connected: true, commands }],
  });
  const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>();
  const runtime = createPluginRuntimeMock({
    config: { current: () => config },
    nodes: { list, invoke },
  });
  const { catalog, services, logger } = registerSessionShare(runtime);
  const scheduler = createTestPluginServiceScheduler();
  const serviceContext = { config, stateDir, logger, invokeNode: invoke, scheduler };
  return {
    catalog,
    list,
    invoke,
    hydrate: async () => {
      const publications: Promise<void>[] = [];
      await catalog.list({
        allowPartialResults: true,
        onHost: () => {},
        waitUntil: (work) => publications.push(work),
      });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all(publications);
    },
    start: () => Promise.all(services.map(async (service) => await service.start(serviceContext))),
    stop: async () => {
      scheduler.beginClose();
      try {
        await Promise.all(services.map(async (service) => await service.stop?.(serviceContext)));
      } finally {
        await scheduler.stop();
      }
    },
    setConfig: (next: OpenClawConfig) => {
      config = next;
    },
  };
}

async function withCatalogFixture(
  run: (fixture: ReturnType<typeof catalogFixture>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    vi.useFakeTimers();
    const fixture = catalogFixture(state.stateDir);
    try {
      await fixture.start();
      await run(fixture);
    } finally {
      // Stop all publishers before the fixture closes its private databases and environment.
      await fixture.stop().finally(() => vi.useRealTimers());
    }
  });
}

describe("session-share node commands", () => {
  it("refreshes shared metadata without rescanning the inventory on the node thread", async () => {
    await withCommands(async (source) => {
      expect((await source.list()).sessions).toEqual([]);
      const scope = { agentId: "main", sessionKey: "agent:main:shared-cache" };
      const entry = {
        sessionId: "shared-cache",
        updatedAt: 100,
        label: "Original",
        category: "Team",
      };
      await replaceSessionEntry(scope, entry);
      expect((await source.list()).sessions).toMatchObject([{ name: "Original" }]);
      const { db } = openOpenClawAgentDatabase({ agentId: "main" });
      const counter = sqlCounter(db, {
        inventory: [/from "session_nodes" order by "session_key"/, /"entry_json"/],
      });
      try {
        expect((await source.list()).sessions).toMatchObject([{ name: "Original" }]);
        expect(counter.counts.inventory).toBe(0);
        await replaceSessionEntry(scope, { ...entry, label: "Renamed" });
        expect((await source.list()).sessions).toMatchObject([{ name: "Renamed" }]);
        await replaceSessionEntry(scope, { ...entry, category: "Private" });
        expect((await source.list()).sessions).toEqual([]);
        await replaceSessionEntry(scope, { ...entry, sessionId: "replacement" });
        expect((await source.list()).sessions).toMatchObject([{ name: "Original" }]);
      } finally {
        counter.restore();
      }
    });
  });

  it("derives titles only for the requested page while preserving transcript-title search", async () => {
    await withCatalogFixture(async (receiver) => {
      const source = commandFixture();
      const named = { threadId: "agent:main:named", name: "Named session" };
      const derived = [0, 1, 2].map((index) => ({
        threadId: `agent:main:derived-${index}`,
        name: `Derived title ${index}`,
      }));
      receiver.invoke.mockImplementation(async ({ command, params }) => {
        const handler = source.commands.find((candidate) => candidate.command === command)!;
        return { payloadJSON: await handler.handle(JSON.stringify(params)) };
      });
      const recency = Date.now();
      for (let index = 0; index < 3; index++) {
        const scope = await writeSession(`derived-${index}`, { updatedAt: recency });
        await appendSessionTranscriptMessageByIdentity({
          ...scope,
          message: { role: "user", content: `Derived title ${index}` },
        });
        await writeSession(scope.sessionId, {
          updatedAt: recency - index,
          lastInteractionAt: recency - index,
          lastActivityAt: recency - index,
        });
      }
      await writeSession("named", { updatedAt: recency + 1, label: "Named session" });
      const { db } = openOpenClawAgentDatabase({ agentId: "main" });
      const counter = sqlCounter(db, {
        participants: [/\bfrom\s+"?session_participants\b/i],
        transcript: [/\btranscript_events\b/],
      });
      try {
        expectSingleItem((await source.list({ limit: 1 })).sessions, named);
        expect.soft(counter.counts).toMatchObject({ transcript: 0, participants: 0 });
      } finally {
        counter.restore();
      }
      const response = JSON.stringify(await source.list({ limit: 100 }));
      expect(JSON.stringify(await source.list({ limit: 100 }))).toBe(response);
      await receiver.hydrate();
      const first = await receiver.catalog.list({ limitPerHost: 1 });
      expectSingleItem(first[0]?.sessions, named);
      expect(first[0]?.nextCursor).toBeDefined();
      const second = await receiver.catalog.list({
        limitPerHost: 2,
        cursors: { "node:alpha": first[0]!.nextCursor! },
      });
      expect(second[0]?.sessions.map(({ threadId, name }) => ({ threadId, name }))).toEqual(
        derived.slice(0, 2),
      );
      const last = await receiver.catalog.list({
        limitPerHost: 2,
        cursors: { "node:alpha": second[0]!.nextCursor! },
      });
      expectSingleItem(last[0]?.sessions, derived[2]);
      expect(last[0]?.nextCursor).toBeUndefined();
      for (const search of ["Derived title 2", "MAIN:DERIVED-2"]) {
        const found = await receiver.catalog.list({ search, limitPerHost: 1 });
        expectSingleItem(found[0]?.sessions, derived[2]);
      }
      expect(receiver.invoke).toHaveBeenCalledTimes(1);
      db.prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ?").run(
        "invalid-json",
        "derived-0",
      );
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

  it("publishes selected root sessions while denying grouped subagents, with stable paging and search", async () => {
    await withCommands(async (fixture) => {
      const profile = githubProfile(4242, "source-person", "Source Person");
      const createdActor = profileActor(profile.id);
      const actor = publishedActor("4242", "Source Person");
      // Keep the tied fixture fresh: subsequent writes prune ancient unarchived sessions.
      const recency = Date.now();
      for (const [key, patch] of [
        [
          "agent:main:alpha",
          {
            label: "Alpha",
            updatedAt: recency,
            color: "blue",
            createdVia: "operator",
            createdActor,
            createdAt: recency - 100,
            execCwd: "/work/alpha",
            spawnedCwd: "/work/ignored",
            parentSessionKey: "agent:main:parent",
            spawnDepth: 0,
          },
        ],
        [
          "agent:main:beta",
          {
            label: "Beta",
            updatedAt: recency,
            archivedAt: recency - 1,
            createdActor,
            createdAt: recency - 90,
            worktree: { id: "beta-worktree", repoRoot: "/work/beta", branch: "b".repeat(6010) },
          },
        ],
        ["agent:main:private", { category: "Other" }],
        ["agent:main:draft", { visibility: "draft" }],
        ["agent:main:incognito", { incognito: true }],
        ["agent:main:catalog:external", {}],
        ["agent:main:subagent:key-only", {}],
        ["agent:main:dashboard:spawn-owned", { createdVia: "spawn" }],
        ["agent:main:acp:resumed-child", { spawnedBy: "agent:main:main", spawnDepth: 1 }],
        ["agent:main:main", { updatedAt: recency - 1 }],
        ["agent:main:cron:job:run:root", { updatedAt: recency - 1, createdVia: "cron" }],
      ] as const) {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: key },
          { sessionId: key, category: "Team", updatedAt: recency + 1, ...patch },
        );
      }
      for (const key of ["subagent:key-only", "dashboard:spawn-owned", "acp:resumed-child"]) {
        await expect.soft(fixture.read(`agent:main:${key}`)).rejects.toThrow("not shared");
      }
      const identityReads = vi.spyOn(githubIdentities, "selectStoredGitHubIdentities");
      let cursor: string | undefined;
      for (const [key, name, age, details] of [
        ["alpha", "Alpha", 100, { color: "blue" }],
        ["beta", "Beta", 90, { gitBranch: "b".repeat(6000), archived: true, status: "archived" }],
      ] as const) {
        const page = await fixture.list({ limit: 1, cursor });
        expect(page.sessions).toEqual([
          {
            ...nativeSession,
            threadId: `agent:main:${key}`,
            name,
            cwd: `/work/${key}`,
            createdAt: recency - age,
            updatedAt: recency,
            recencyAt: recency,
            createdActor: actor,
            ...details,
          },
        ]);
        expect.soft(identityReads).not.toHaveBeenCalled();
        expect(page.nextCursor).toBeDefined();
        cursor = page.nextCursor;
        identityReads.mockClear();
      }
      const roots = await fixture.list({ cursor });
      expect(roots.sessions.map((session) => session.threadId)).toEqual([
        "agent:main:cron:job:run:root",
        "agent:main:main",
      ]);
      expect.soft(identityReads).not.toHaveBeenCalled();
      expect(roots.nextCursor).toBeUndefined();
      for (const [searchTerm, key] of [
        ["ALPHA", "alpha"],
        ["MAIN:BETA", "beta"],
      ]) {
        expect((await fixture.list({ searchTerm })).sessions.map((s) => s.threadId)).toEqual([
          `agent:main:${key}`,
        ]);
      }
      for (const key of ["private", "draft", "incognito", "catalog:external"]) {
        await expect(fixture.read(`agent:main:${key}`)).rejects.toThrow("not shared");
      }
      await expect(fixture.list({ cursor: "invalid" })).rejects.toThrow();
      await expect(fixture.list({ unexpected: true })).rejects.toThrow("Unknown");
    });
  });

  it("batches distinct and repeated creators without mixing labels or retaining facts across requests", async () => {
    await withCommands(async (fixture) => {
      const creator = githubProfile(
        4242,
        "original-person",
        "Original Person",
        "creator@example.test",
      );
      const target = githubProfile(4343, "merged-person", "Merged Person", "target@example.test");
      const distinct = Array.from({ length: 8 }, (_, index) => ({
        accountId: 5000 + index,
        profile: githubProfile(
          5000 + index,
          `person-${index}`,
          `Person ${index}`,
          `person-${index}@example.test`,
        ),
      }));
      const actor = profileActor(creator.id);
      const actors = [
        ...Array.from({ length: 8 }, () => actor),
        ...distinct.map(({ profile }) => profileActor(profile.id)),
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
      const counter = sqlCounter(openOpenClawStateDatabase().db, {
        identities: [/\bfrom\s+"?user_profile_identities\b/i],
        profiles: [/\bfrom\s+"?user_profiles\b/i],
      });
      let first: SessionPage;
      try {
        first = await fixture.list();
        expect.soft(counter.counts).toMatchObject({ identities: 0, profiles: 0 });
      } finally {
        counter.restore();
      }
      expect(first.sessions.map((session) => session.createdActor)).toEqual([
        ...Array.from({ length: 8 }, () => publishedActor("4242", "Original Person")),
        ...distinct.map(({ accountId }, index) =>
          publishedActor(String(accountId), `Person ${index}`),
        ),
        ...["First fallback", "Second fallback"].map((label) =>
          publishedActor("missing", label, "profile"),
        ),
        { type: "human", id: creator.id, label: "Channel person" },
        { type: "agent", id: creator.id, label: "Agent" },
      ]);
      linkEmail("creator@example.test", target.id);
      const refreshed = await fixture.list();
      expect(refreshed.sessions.slice(0, 8).map((session) => session.createdActor)).toEqual(
        Array.from({ length: 8 }, () => publishedActor("4343", "Merged Person")),
      );
      expect(refreshed.sessions.slice(8)).toEqual(first.sessions.slice(8));
      openOpenClawStateDatabase()
        .db.prepare("UPDATE user_profiles SET primary_github_account_id = ? WHERE id = ?")
        .run(9007199254740992n, target.id);
      await expect(fixture.list({ limit: 1 })).rejects.toThrow(RangeError);
      const tail = await fixture.list({ cursor: sessionCatalogPaging.encodeCursor(8) });
      expect(tail.sessions).toEqual(first.sessions.slice(8));
    });
  });

  it("propagates a failed profile reader without replaying creator queries on the host", async () => {
    await withCommands(async (fixture) => {
      const now = Date.now();
      for (const index of [0, 1]) {
        const profile = ensureProfileForEmail(`terminal-${index}@example.test`);
        await writeSession(`terminal-${index}`, {
          updatedAt: now - index,
          label: `Terminal ${index}`,
          createdActor: profileActor(profile.id),
        });
      }
      const cached = openOpenClawStateDatabase();
      const corruption = Object.assign(new Error("database disk image is malformed"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 11,
      });
      const native = vi.spyOn(githubIdentities, "selectStoredGitHubIdentities");
      const failure = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockRejectedValueOnce(corruption);
      try {
        await expect(fixture.list()).rejects.toBe(corruption);
        expect(native).not.toHaveBeenCalled();
        expect(cached.db.isOpen).toBe(true);
      } finally {
        failure.mockRestore();
      }
    });
  });

  it.each(["list", "read"] as const)(
    "refuses a replaced physical source during %s identity preparation",
    async (operation) => {
      await withCommands(async (fixture) => {
        const profile = ensureProfileForEmail("physical@example.test");
        const { scope, appendUser } = await writeProfileSession("physical", profile.id);
        await appendUser("Shared");
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

  it("reads real newest-first transcript rows with portable sender and revokes moved sessions", async () => {
    await withCommands(async (fixture) => {
      const profile = ensureProfileForEmail("source@example.test");
      const { scope, appendUser } = await writeProfileSession("shared", profile.id, 1);
      await appendUser("Shared question", 1);
      await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Shared answer" }],
          timestamp: 2,
        },
      });
      const first = await fixture.read(scope.sessionKey, { limit: 1 });
      expectSingleItem(first.items, { type: "agentMessage", text: "Shared answer" });
      const older = await fixture.read(scope.sessionKey, { limit: 1, cursor: first.nextCursor });
      expect(older.items).toEqual([
        expect.objectContaining({
          type: "userMessage",
          text: "Shared question",
          sender: expect.objectContaining({
            identity: publishedActor(profile.id, "", "profile").identity,
          }),
        }),
      ]);
      expect((await fixture.list()).sessions[0]?.createdActor?.identity).toEqual(
        older.items[0]?.sender?.identity,
      );
      await upsertSessionEntryCore(scope, { category: "Private" });
      await expect(fixture.read(scope.sessionKey)).rejects.toThrow("not shared");
      expect((await fixture.list()).sessions).toEqual([]);
    });
  });

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
  it("rejects an earlier host snapshot after another host prepares", async () => {
    await withCatalogFixture(async (fixture) => {
      githubProfile(702, "second-host", "Second", "second-host@example.test");
      fixture.list.mockResolvedValue({
        nodes: ["alpha", "beta"].map((nodeId) => ({ nodeId, connected: true, commands })),
      });
      fixture.setConfig(
        nodeConfig({
          alpha: { linkGitHubIdentities: false },
          beta: { linkGitHubIdentities: true },
        }),
      );
      fixture.invoke.mockImplementation(async ({ nodeId }) => ({
        sessions: [
          {
            ...nativeSession,
            createdActor: {
              type: "human",
              identity: { ...remoteIdentity, id: nodeId === "alpha" ? "701" : "702" },
            },
          },
        ],
      }));
      await fixture.hydrate();
      const firstPublished = createDeferredCore();
      const gate = holdStateRead();
      const pending = fixture.catalog.list({
        onHost: (host) => {
          if (host.hostId === "node:alpha") {
            expect(host.sessions[0]?.threadId).toBe(nativeSession.threadId);
            firstPublished.resolve();
          }
        },
      });
      try {
        await Promise.race([
          Promise.all([firstPublished.promise, gate.entered]),
          pending.then(() => {
            throw new Error("Second host was not held");
          }),
        ]);
        fixture.list.mockResolvedValue({
          nodes: [{ nodeId: "beta", connected: true, commands }],
        });
        await fixture.catalog.list({ hostIds: [] });
      } finally {
        gate.release();
      }
      await expect(pending).rejects.toThrow("Session Share is unavailable");
    });
  });

  it("keeps claims remote by default and applies only explicit owner and numeric GitHub links", async () => {
    const nodeId = "alpha";
    await withCatalogFixture(async (fixture) => {
      const profile = githubProfile(4242, "catalog-person", "Catalog Person");
      fixture.list.mockResolvedValue({ nodes: [{ nodeId, connected: true, commands }] });
      const hostId = `node:${nodeId}`;
      const namespacedIdentity = { ...remoteIdentity, domain: hostId };
      const identityReads = vi.spyOn(githubIdentities, "selectStoredGitHubIdentities");
      const fullIdentityScans = () =>
        identityReads.mock.calls.filter(([, profileIds]) => profileIds === undefined).length;
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
      fixture.invoke.mockImplementation(async ({ command }) =>
        command === commands[0] ? { sessions: [human, agent, unmatched] } : transcript,
      );
      const namespacedHuman = remoteHuman(human.threadId, "4242", hostId);
      const namespacedUnmatched = remoteHuman(unmatched.threadId, "9999", hostId);
      await fixture.hydrate();
      expect((await fixture.catalog.list({}))[0]?.sessions).toEqual([
        namespacedHuman,
        agent,
        namespacedUnmatched,
      ]);
      expect(
        (await fixture.catalog.read({ hostId, threadId: nativeSession.threadId })).items[0]?.sender
          ?.identity,
      ).toEqual(namespacedIdentity);
      expect(fullIdentityScans()).toBe(0);
      for (const identityConfig of [
        { owner: `profile:${profile.id}` },
        { owner: "github:CATALOG-PERSON" },
        { linkGitHubIdentities: true },
      ]) {
        const linksHumans = "linkGitHubIdentities" in identityConfig;
        fixture.setConfig(nodeConfig({ [nodeId]: identityConfig }));
        await fixture.hydrate();
        if (linksHumans) {
          identityReads.mockClear();
        }
        const rows = (await fixture.catalog.list({}))[0]!.sessions;
        expect(rows[linksHumans ? 0 : 1]?.createdActor).toMatchObject(linkedActor(profile.id));
        expect(rows[linksHumans ? 1 : 0]).toEqual(linksHumans ? agent : namespacedHuman);
        expect(rows[2]).toEqual(namespacedUnmatched);
        if (linksHumans) {
          expect.soft(fullIdentityScans()).toBe(0);
        }
      }
      identityReads.mockClear();
      const page = await fixture.catalog.read({ hostId, threadId: nativeSession.threadId });
      expect.soft(fullIdentityScans()).toBe(0);
      expect(page.items.map((item) => item.sender)).toEqual([
        { identity: { type: "profile", id: profile.id }, label: "Catalog Person" },
        { identity: { type: "profile", id: profile.id }, label: "Catalog Person" },
        { identity: { ...namespacedIdentity, id: "9999" }, label: "Remote Person" },
      ]);
    });
  });
});
