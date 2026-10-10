import { createHash } from "node:crypto";
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
import {
  appendSessionTranscriptMessageByIdentity,
  appendSessionTranscriptMessagesByIdentity,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import sessionSharePlugin from "../../extensions/session-share/index.js";
import {
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../src/config/sessions/session-accessor.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import { createDeferredCore } from "../../src/shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../src/state/openclaw-agent-db.js";
import * as stateReads from "../../src/state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../src/state/openclaw-state-db.js";
import * as profileEvents from "../../src/state/user-profile-events.js";
import * as githubIdentities from "../../src/state/user-profile-github-identity.js";
import {
  linkEmail,
  setDisplayName,
  syncGitHubIdentity,
} from "../../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../src/state/user-profiles.js";
import { trackSqliteStatementExecutions } from "../helpers/sqlite-statement-execution-counter.js";

afterEach(() => vi.restoreAllMocks());

function registerSessionShare(runtime: PluginRuntime, config: OpenClawConfig = {}) {
  const nodeCommands: OpenClawPluginNodeHostCommand[] = [];
  const catalogs: SessionCatalogProvider[] = [];
  const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
  const api = createTestPluginApi({
    runtime,
    config,
    registerNodeHostCommand: (command) => {
      nodeCommands.push(command);
    },
    registerSessionCatalog: (catalog) => {
      catalogs.push(catalog);
    },
    registerService: (service) => {
      services.push(service);
    },
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

function commandFixture(groups: string[] = ["Team"]) {
  const config: OpenClawConfig = {
    plugins: { entries: { "session-share": { enabled: true, config: { share: { groups } } } } },
  };
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

function catalogFixture(stateDir: string) {
  let config: OpenClawConfig = {};
  const list = vi.fn<PluginRuntime["nodes"]["list"]>().mockResolvedValue({
    nodes: [{ nodeId: "alpha", displayName: " Alpha ", connected: true, commands }],
  });
  const invoke = vi
    .fn<PluginRuntime["nodes"]["invoke"]>()
    .mockImplementation(async ({ command }) =>
      command === commands[0]
        ? { payloadJSON: JSON.stringify({ sessions: [nativeSession] }) }
        : {
            payloadJSON: JSON.stringify({
              threadId: nativeSession.threadId,
              items: [{ type: "userMessage", text: "Published question" }],
            }),
          },
    );
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
    start: async () => {
      await Promise.all(
        services.map(async (service) => {
          await service.start(serviceContext);
        }),
      );
    },
    stop: async () => {
      scheduler.beginClose();
      try {
        await Promise.all(
          services.map(async (service) => {
            await service.stop?.(serviceContext);
          }),
        );
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
      try {
        await fixture.stop();
      } finally {
        vi.useRealTimers();
      }
    }
  });
}

describe("session-share node commands", () => {
  it("refreshes shared metadata without rescanning the inventory on the node thread", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const source = commandFixture();
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
      const reads = trackSqliteStatementExecutions(db, ["inventory"], (sql) =>
        sql.includes('from "session_nodes" order by "session_key"') && sql.includes('"entry_json"')
          ? "inventory"
          : null,
      );
      try {
        expect((await source.list()).sessions).toMatchObject([{ name: "Original" }]);
        expect(reads.counts.inventory).toBe(0);
        await replaceSessionEntry(scope, { ...entry, label: "Renamed" });
        expect((await source.list()).sessions).toMatchObject([{ name: "Renamed" }]);
        await replaceSessionEntry(scope, { ...entry, category: "Private" });
        expect((await source.list()).sessions).toEqual([]);
        await replaceSessionEntry(scope, { ...entry, sessionId: "replacement" });
        expect((await source.list()).sessions).toMatchObject([{ name: "Original" }]);
      } finally {
        reads.restore();
      }
    });
  });

  it("derives titles only for the requested page while preserving transcript-title search", async () => {
    await withCatalogFixture(async (receiver) => {
      const source = commandFixture();
      receiver.invoke.mockImplementation(async ({ command, params }) => {
        const handler = source.commands.find((candidate) => candidate.command === command)!;
        return { payloadJSON: await handler.handle(JSON.stringify(params)) };
      });
      const recency = Date.now();
      for (let index = 0; index < 3; index++) {
        const scope = {
          agentId: "main",
          sessionKey: `agent:main:derived-${index}`,
          sessionId: `derived-${index}`,
        };
        await replaceSessionEntry(scope, {
          sessionId: scope.sessionId,
          updatedAt: recency,
          category: "Team",
        });
        await appendSessionTranscriptMessageByIdentity({
          ...scope,
          message: { role: "user", content: `Derived title ${index}` },
        });
        await replaceSessionEntry(scope, {
          sessionId: scope.sessionId,
          category: "Team",
          updatedAt: recency - index,
          lastInteractionAt: recency - index,
          lastActivityAt: recency - index,
        });
      }
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:named" },
        {
          sessionId: "named",
          updatedAt: recency + 1,
          category: "Team",
          label: "Named session",
        },
      );
      const { db } = openOpenClawAgentDatabase({ agentId: "main" });
      const counter = trackSqliteStatementExecutions(db, ["transcript", "participants"], (sql) =>
        /\bfrom\s+"?session_participants\b/i.test(sql)
          ? "participants"
          : /\btranscript_events\b/.test(sql)
            ? "transcript"
            : null,
      );
      try {
        expect((await source.list({ limit: 1 })).sessions).toMatchObject([
          { threadId: "agent:main:named", name: "Named session" },
        ]);
        expect.soft(counter.counts.transcript).toBe(0);
        expect.soft(counter.counts.participants).toBe(0);
      } finally {
        counter.restore();
      }
      const responses = [
        JSON.stringify(await source.list({ limit: 100 })),
        JSON.stringify(await source.list({ limit: 100 })),
      ];
      const hashes = responses.map((response) =>
        createHash("sha256").update(response).digest("hex"),
      );
      expect(hashes[1]).toBe(hashes[0]);
      console.info("Session Share paired source response", {
        bytes: responses.map((response) => Buffer.byteLength(response)),
        hashes,
      });
      await receiver.hydrate();
      const first = await receiver.catalog.list({ limitPerHost: 1 });
      expect(first[0]?.sessions).toMatchObject([
        { threadId: "agent:main:named", name: "Named session" },
      ]);
      expect(first[0]?.nextCursor).toBeDefined();
      const second = await receiver.catalog.list({
        limitPerHost: 2,
        cursors: { "node:alpha": first[0]!.nextCursor! },
      });
      expect(second[0]?.sessions.map(({ threadId, name }) => ({ threadId, name }))).toEqual([
        { threadId: "agent:main:derived-0", name: "Derived title 0" },
        { threadId: "agent:main:derived-1", name: "Derived title 1" },
      ]);
      const last = await receiver.catalog.list({
        limitPerHost: 2,
        cursors: { "node:alpha": second[0]!.nextCursor! },
      });
      expect(last[0]?.sessions).toMatchObject([
        { threadId: "agent:main:derived-2", name: "Derived title 2" },
      ]);
      expect(last[0]?.nextCursor).toBeUndefined();
      for (const search of ["Derived title 2", "MAIN:DERIVED-2"]) {
        const found = await receiver.catalog.list({ search, limitPerHost: 1 });
        expect(found[0]?.sessions).toMatchObject([
          { threadId: "agent:main:derived-2", name: "Derived title 2" },
        ]);
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
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:configured",
          sessionId: "configured-session",
        };
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
        expect.soft((await fixture.list()).sessions).toEqual([
          expect.objectContaining({
            threadId: scope.sessionKey,
            name: "Configured store question",
          }),
        ]);
        expect
          .soft((await fixture.read(scope.sessionKey)).items)
          .toEqual([
            expect.objectContaining({ type: "userMessage", text: "Configured store question" }),
          ]);

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
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = commandFixture();
      const profile = syncGitHubIdentity({
        identity: { accountId: 4242, login: "source-person", name: "Source Person" },
        authenticationAlias: { kind: "github-login", login: "source-person" },
      });
      const createdActor = { type: "human", source: "profile", id: profile.id } as const;
      const publishedActor = {
        type: "human",
        id: "4242",
        label: "Source Person",
        identity: {
          type: "remote",
          pluginId: "session-share",
          domain: "openclaw",
          idKind: "github-account",
          id: "4242",
        },
      };
      // Keep the tied fixture fresh: subsequent writes prune ancient unarchived sessions.
      const recency = Date.now();
      for (const [key, patch] of [
        [
          "agent:main:alpha",
          {
            label: "Alpha",
            category: "Team",
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
            category: "Team",
            updatedAt: recency,
            archivedAt: recency - 1,
            createdActor,
            createdAt: recency - 90,
            worktree: { id: "beta-worktree", repoRoot: "/work/beta", branch: "b".repeat(6010) },
          },
        ],
        ["agent:main:private", { label: "Private", category: "Other", updatedAt: recency + 1 }],
        [
          "agent:main:draft",
          { label: "Draft", category: "Team", visibility: "draft", updatedAt: recency + 1 },
        ],
        [
          "agent:main:incognito",
          { label: "Incognito", category: "Team", incognito: true, updatedAt: recency + 1 },
        ],
        [
          "agent:main:catalog:external",
          { label: "Adopted", category: "Team", updatedAt: recency + 1 },
        ],
        [
          "agent:main:subagent:key-only",
          { label: "Subagent", category: "Team", updatedAt: recency + 1 },
        ],
        [
          "agent:main:dashboard:spawn-owned",
          { category: "Team", updatedAt: recency + 1, createdVia: "spawn" },
        ],
        [
          "agent:main:acp:resumed-child",
          {
            category: "Team",
            updatedAt: recency + 1,
            spawnedBy: "agent:main:main",
            spawnDepth: 1,
          },
        ],
        ["agent:main:main", { category: "Team", updatedAt: recency - 1 }],
        [
          "agent:main:cron:job:run:root",
          { category: "Team", updatedAt: recency - 1, createdVia: "cron" },
        ],
      ] as const) {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: key },
          { sessionId: key, ...patch },
        );
      }
      for (const key of ["subagent:key-only", "dashboard:spawn-owned", "acp:resumed-child"]) {
        await expect.soft(fixture.read(`agent:main:${key}`)).rejects.toThrow("not shared");
      }
      const identityReads = vi.spyOn(githubIdentities, "selectStoredGitHubIdentities");
      const first = await fixture.list({ limit: 1 });
      expect(first.sessions).toEqual([
        {
          threadId: "agent:main:alpha",
          name: "Alpha",
          color: "blue",
          cwd: "/work/alpha",
          status: "idle",
          createdAt: recency - 100,
          updatedAt: recency,
          recencyAt: recency,
          archived: false,
          canContinue: false,
          canArchive: false,
          canOpenTerminal: false,
          createdActor: publishedActor,
        },
      ]);
      expect.soft(identityReads).not.toHaveBeenCalled();
      expect(first.nextCursor).toBeDefined();
      identityReads.mockClear();
      const older = await fixture.list({ limit: 1, cursor: first.nextCursor });
      expect(older.sessions).toEqual([
        {
          threadId: "agent:main:beta",
          name: "Beta",
          cwd: "/work/beta",
          createdAt: recency - 90,
          updatedAt: recency,
          recencyAt: recency,
          gitBranch: "b".repeat(6000),
          archived: true,
          status: "archived",
          canContinue: false,
          canArchive: false,
          canOpenTerminal: false,
          createdActor: publishedActor,
        },
      ]);
      expect.soft(identityReads).not.toHaveBeenCalled();
      expect(older.nextCursor).toBeDefined();
      identityReads.mockClear();
      const roots = await fixture.list({ cursor: older.nextCursor });
      expect(roots.sessions.map((session) => session.threadId)).toEqual([
        "agent:main:cron:job:run:root",
        "agent:main:main",
      ]);
      expect.soft(identityReads).not.toHaveBeenCalled();
      expect(roots.nextCursor).toBeUndefined();
      expect(
        (await fixture.list({ searchTerm: "ALPHA" })).sessions.map((session) => session.threadId),
      ).toEqual(["agent:main:alpha"]);
      expect(
        (await fixture.list({ searchTerm: "MAIN:BETA" })).sessions.map(
          (session) => session.threadId,
        ),
      ).toEqual(["agent:main:beta"]);
      for (const key of ["private", "draft", "incognito", "catalog:external"]) {
        await expect(fixture.read(`agent:main:${key}`)).rejects.toThrow("not shared");
      }
      await expect(fixture.list({ cursor: "invalid" })).rejects.toThrow();
      await expect(fixture.list({ unexpected: true })).rejects.toThrow("Unknown");
    });
  });

  it("batches distinct and repeated creators without mixing labels or retaining facts across requests", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = commandFixture();
      const creator = syncGitHubIdentity({
        identity: { accountId: 4242, login: "original-person", name: "Original Person" },
        authenticationAlias: { kind: "email", email: "creator@example.test" },
      });
      const target = syncGitHubIdentity({
        identity: { accountId: 4343, login: "merged-person", name: "Merged Person" },
        authenticationAlias: { kind: "email", email: "target@example.test" },
      });
      const distinct = Array.from({ length: 8 }, (_, index) => ({
        accountId: 5000 + index,
        profile: syncGitHubIdentity({
          identity: { accountId: 5000 + index, login: `person-${index}`, name: `Person ${index}` },
          authenticationAlias: { kind: "email", email: `person-${index}@example.test` },
        }),
      }));
      const actor = { type: "human", source: "profile", id: creator.id } as const;
      const actors = [
        ...Array.from({ length: 8 }, () => actor),
        ...distinct.map(
          ({ profile }) => ({ type: "human", source: "profile", id: profile.id }) as const,
        ),
        { type: "human", source: "profile", id: "missing", label: "First fallback" },
        { type: "human", source: "profile", id: "missing", label: "Second fallback" },
        { type: "human", source: "channel", id: creator.id, label: "Channel person" },
        { type: "agent", id: creator.id, label: "Agent" },
      ] as const;
      const now = Date.now();
      for (const [index, createdActor] of actors.entries()) {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: `agent:main:creator-${index}` },
          {
            sessionId: `creator-${index}`,
            updatedAt: now - index,
            label: `Session ${index}`,
            category: "Team",
            createdActor,
          },
        );
      }
      const counter = trackSqliteStatementExecutions(
        openOpenClawStateDatabase().db,
        ["identities", "profiles"],
        (sql) =>
          /\bfrom\s+"?user_profile_identities\b/i.test(sql)
            ? "identities"
            : /\bfrom\s+"?user_profiles\b/i.test(sql)
              ? "profiles"
              : null,
      );
      let first: SessionPage;
      try {
        first = await fixture.list();
        expect.soft(counter.counts.identities).toBe(0);
        expect.soft(counter.counts.profiles).toBe(0);
      } finally {
        counter.restore();
      }
      const portable = (id: string, idKind = "github-account") => ({
        type: "remote",
        pluginId: "session-share",
        domain: "openclaw",
        idKind,
        id,
      });
      expect(first.sessions.map((session) => session.createdActor)).toEqual([
        ...Array.from({ length: 8 }, () => ({
          type: "human",
          id: "4242",
          label: "Original Person",
          identity: portable("4242"),
        })),
        ...distinct.map(({ accountId }, index) => ({
          type: "human",
          id: String(accountId),
          label: `Person ${index}`,
          identity: portable(String(accountId)),
        })),
        ...["First fallback", "Second fallback"].map((label) => ({
          type: "human",
          id: "missing",
          label,
          identity: portable("missing", "profile"),
        })),
        { type: "human", id: creator.id, label: "Channel person" },
        { type: "agent", id: creator.id, label: "Agent" },
      ]);
      linkEmail("creator@example.test", target.id);
      const refreshed = await fixture.list();
      expect(refreshed.sessions.slice(0, 8).map((session) => session.createdActor)).toEqual(
        Array.from({ length: 8 }, () => ({
          type: "human",
          id: "4343",
          label: "Merged Person",
          identity: portable("4343"),
        })),
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

  it.each(["profile", "identity"])(
    "preserves the first creator's %s error when a later cohort row is corrupt",
    async (first) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const fixture = commandFixture();
        const profiles = [0, 1].map((index) =>
          syncGitHubIdentity({
            identity: { accountId: 6000 + index, login: `ordered-${index}` },
            authenticationAlias: { kind: "email", email: `ordered-${index}@example.test` },
          }),
        );
        const now = Date.now();
        for (const [index, profile] of profiles.entries()) {
          await replaceSessionEntry(
            { agentId: "main", sessionKey: `agent:main:ordered-${index}` },
            {
              sessionId: `ordered-${index}`,
              updatedAt: now - index,
              label: `Ordered ${index}`,
              category: "Team",
              createdActor: { type: "human", source: "profile", id: profile.id },
            },
          );
        }
        const { db } = openOpenClawStateDatabase();
        const profileIndex = first === "profile" ? 0 : 1;
        db.prepare("UPDATE user_profiles SET updated_at = ? WHERE id = ?").run(
          9223372036854775807n,
          profiles[profileIndex]!.id,
        );
        db.prepare("UPDATE user_profiles SET primary_github_account_id = ? WHERE id = ?").run(
          9007199254740992n,
          profiles[1 - profileIndex]!.id,
        );
        const singleFailure: unknown = await fixture
          .list({ limit: 1 })
          .catch((error: unknown) => error);
        expect(singleFailure).toBeInstanceOf(RangeError);
        if (!(singleFailure instanceof Error)) {
          throw new Error("Expected the first creator's native error");
        }
        await expect(fixture.list()).rejects.toMatchObject({
          name: singleFailure.name,
          message: singleFailure.message,
          code: "ERR_OUT_OF_RANGE",
        });
      });
    },
  );

  it("propagates a failed profile reader without replaying creator queries on the host", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = commandFixture();
      const now = Date.now();
      for (const index of [0, 1]) {
        const profile = ensureProfileForEmail(`terminal-${index}@example.test`);
        await replaceSessionEntry(
          { agentId: "main", sessionKey: `agent:main:terminal-${index}` },
          {
            sessionId: `terminal-${index}`,
            updatedAt: now - index,
            label: `Terminal ${index}`,
            category: "Team",
            createdActor: { type: "human", source: "profile", id: profile.id },
          },
        );
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
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const profile = ensureProfileForEmail("physical@example.test");
        const scope = { agentId: "main", sessionKey: "agent:main:physical", sessionId: "physical" };
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          updatedAt: Date.now(),
          label: "Shared",
          category: "Team",
          createdActor: { type: "human", source: "profile", id: profile.id },
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
        const accepted = createDeferredCore();
        const release = createDeferredCore();
        const execute = stateReads.executeExistingOpenClawStateRead;
        vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementationOnce(
          async (...args) => {
            const result = await execute(...args);
            accepted.resolve();
            await release.promise;
            return result;
          },
        );
        const fixture = commandFixture();
        const pending = operation === "list" ? fixture.list() : fixture.read(scope.sessionKey);
        try {
          await Promise.race([
            accepted.promise,
            pending.then(() => {
              throw new Error("Read was not held");
            }),
          ]);
          await closeOpenClawAgentDatabasesAsync();
          fs.renameSync(pathname, `${pathname}.previous`);
          fs.copyFileSync(`${pathname}.previous`, pathname);
        } finally {
          release.resolve();
        }
        await expect(pending).rejects.toThrow(/identity|changed/i);
      });
    },
  );

  it("revalidates earlier senders after preparing a later transcript batch", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const first = ensureProfileForEmail("first@example.test");
      const second = ensureProfileForEmail("second@example.test");
      const scope = { agentId: "main", sessionKey: "agent:main:cohorts", sessionId: "cohorts" };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: Date.now(),
        label: "Shared",
        category: "Team",
      });
      await appendSessionTranscriptMessagesByIdentity({
        ...scope,
        messages: [
          {
            message: {
              role: "user",
              content: "Older",
              __openclaw: { senderIdentity: { type: "profile", id: second.id } },
            },
          },
          { message: { role: "assistant", content: "NO_REPLY" } },
          { message: { role: "assistant", content: "NO_REPLY" } },
          {
            message: {
              role: "user",
              content: "Newest",
              __openclaw: { senderIdentity: { type: "profile", id: first.id } },
            },
          },
        ],
      });
      const capture = profileEvents.captureUserProfileAuthorityRead;
      let cohorts = 0;
      vi.spyOn(profileEvents, "captureUserProfileAuthorityRead").mockImplementation(
        async (...args) => {
          const authority = await capture(...args);
          if (++cohorts === 2) {
            setDisplayName(first.id, "Changed during later preparation");
          }
          return authority;
        },
      );
      await expect(commandFixture().read(scope.sessionKey, { limit: 2 })).rejects.toThrow(
        "identities changed",
      );
      expect(cohorts).toBe(2);
    });
  });

  it("reads real newest-first transcript rows with portable sender and revokes moved sessions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("source@example.test");
      const scope = { agentId: "main", sessionKey: "agent:main:shared", sessionId: "shared" };
      await upsertSessionEntryCore(scope, {
        sessionId: "shared",
        updatedAt: 1,
        label: "Shared",
        category: "Team",
        createdActor: { type: "human", source: "profile", id: profile.id },
      });
      await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: {
          role: "user",
          content: "Shared question",
          timestamp: 1,
          __openclaw: { senderIdentity: { type: "profile", id: profile.id } },
        },
      });
      await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Shared answer" }],
          timestamp: 2,
        },
      });
      const fixture = commandFixture();
      const first = await fixture.read(scope.sessionKey, { limit: 1 });
      expect(first.items).toEqual([
        expect.objectContaining({ type: "agentMessage", text: "Shared answer" }),
      ]);
      const older = await fixture.read(scope.sessionKey, { limit: 1, cursor: first.nextCursor });
      expect(older.items).toEqual([
        expect.objectContaining({
          type: "userMessage",
          text: "Shared question",
          sender: expect.objectContaining({
            identity: {
              type: "remote",
              pluginId: "session-share",
              domain: "openclaw",
              idKind: "profile",
              id: profile.id,
            },
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
  it.each(["identity", "snapshot"] as const)(
    "revalidates an earlier host's %s after another host finishes identity preparation",
    async (changed) => {
      await withCatalogFixture(async (fixture) => {
        const first = syncGitHubIdentity({
          identity: { accountId: 701, login: "first-host", name: "Before" },
          authenticationAlias: { kind: "email", email: "first-host@example.test" },
        });
        syncGitHubIdentity({
          identity: { accountId: 702, login: "second-host", name: "Second" },
          authenticationAlias: { kind: "email", email: "second-host@example.test" },
        });
        fixture.list.mockResolvedValue({
          nodes: ["alpha", "beta"].map((nodeId) => ({ nodeId, connected: true, commands })),
        });
        fixture.setConfig({
          plugins: {
            entries: {
              "session-share": {
                config: {
                  nodes: {
                    alpha: { linkGitHubIdentities: changed === "identity" },
                    beta: { linkGitHubIdentities: true },
                  },
                },
              },
            },
          },
        });
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
        const secondPreparing = createDeferredCore();
        const release = createDeferredCore();
        const capture = profileEvents.captureUserProfileAuthorityRead;
        const expectedCohorts = changed === "identity" ? 2 : 1;
        let cohorts = 0;
        vi.spyOn(profileEvents, "captureUserProfileAuthorityRead").mockImplementation(
          async (...args) => {
            if (++cohorts === expectedCohorts) {
              secondPreparing.resolve();
              await release.promise;
            }
            return capture(...args);
          },
        );
        const pending = fixture.catalog.list({
          onHost: (host) => {
            if (host.hostId === "node:alpha") {
              expect(host.sessions[0]?.threadId).toBe(nativeSession.threadId);
              if (changed === "identity") {
                expect(host.sessions[0]?.createdActor?.label).toBe("Before");
              }
              firstPublished.resolve();
            }
          },
        });
        try {
          await Promise.race([
            Promise.all([firstPublished.promise, secondPreparing.promise]),
            pending.then(() => {
              throw new Error("Second host was not held");
            }),
          ]);
          if (changed === "identity") {
            setDisplayName(first.id, "Changed during second host preparation");
          } else {
            fixture.list.mockResolvedValue({
              nodes: [{ nodeId: "beta", connected: true, commands }],
            });
            await fixture.catalog.list({ hostIds: [] });
          }
        } finally {
          release.resolve();
        }
        await expect(pending).rejects.toThrow(
          changed === "identity" ? "identities changed" : "Session Share is unavailable",
        );
        expect(cohorts).toBe(expectedCohorts);
      });
    },
  );

  it("keeps claims remote by default and applies only explicit owner and numeric GitHub links", async () => {
    const nodeId = "alpha";
    await withCatalogFixture(async (fixture) => {
      const profile = syncGitHubIdentity({
        identity: { accountId: 4242, login: "catalog-person", name: "Catalog Person" },
        authenticationAlias: { kind: "github-login", login: "catalog-person" },
      });
      fixture.list.mockResolvedValue({ nodes: [{ nodeId, connected: true, commands }] });
      const hostId = `node:${nodeId}`;
      const namespacedIdentity = { ...remoteIdentity, domain: hostId };
      const identityReads = vi.spyOn(githubIdentities, "selectStoredGitHubIdentities");
      const fullIdentityScans = () =>
        identityReads.mock.calls.filter(([, profileIds]) => profileIds === undefined).length;
      const human = {
        ...nativeSession,
        createdActor: {
          type: "human" as const,
          id: "4242",
          identity: remoteIdentity,
          label: "Remote Person",
        },
      };
      const agent = {
        ...nativeSession,
        threadId: "agent:main:agent",
        createdActor: { type: "agent" as const, id: "assistant", label: "Assistant" },
      };
      const unmatched = {
        ...human,
        threadId: "agent:main:unmatched",
        createdActor: {
          ...human.createdActor,
          id: "9999",
          identity: { ...remoteIdentity, id: "9999" },
        },
      };
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
      const namespacedHuman = {
        ...human,
        createdActor: { ...human.createdActor, identity: namespacedIdentity },
      };
      const namespacedUnmatched = {
        ...unmatched,
        createdActor: {
          ...unmatched.createdActor,
          identity: { ...namespacedIdentity, id: "9999" },
        },
      };
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
      for (const owner of [`profile:${profile.id}`, "github:CATALOG-PERSON"]) {
        fixture.setConfig({
          plugins: {
            entries: { "session-share": { config: { nodes: { [nodeId]: { owner } } } } },
          },
        });
        await fixture.hydrate();
        const rows = (await fixture.catalog.list({}))[0]!.sessions;
        expect(rows[0]).toEqual(namespacedHuman);
        expect(rows[1]?.createdActor).toMatchObject({
          type: "human",
          id: profile.id,
          identity: { type: "profile", id: profile.id },
          label: "Catalog Person",
        });
        expect(rows[2]).toEqual(namespacedUnmatched);
      }
      fixture.setConfig({
        plugins: {
          entries: {
            "session-share": { config: { nodes: { [nodeId]: { linkGitHubIdentities: true } } } },
          },
        },
      });
      await fixture.hydrate();
      identityReads.mockClear();
      const linked = (await fixture.catalog.list({}))[0]!.sessions;
      expect.soft(fullIdentityScans()).toBe(0);
      expect(linked[0]?.createdActor).toMatchObject({
        type: "human",
        id: profile.id,
        identity: { type: "profile", id: profile.id },
        label: "Catalog Person",
      });
      expect(linked[1]).toEqual(agent);
      expect(linked[2]).toEqual(namespacedUnmatched);
      identityReads.mockClear();
      const page = await fixture.catalog.read({
        hostId,
        threadId: nativeSession.threadId,
      });
      expect.soft(fullIdentityScans()).toBe(0);
      expect(page.items.map((item) => item.sender)).toEqual([
        { identity: { type: "profile", id: profile.id }, label: "Catalog Person" },
        { identity: { type: "profile", id: profile.id }, label: "Catalog Person" },
        { identity: { ...namespacedIdentity, id: "9999" }, label: "Remote Person" },
      ]);
    });
  });
});
