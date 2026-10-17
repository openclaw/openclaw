import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore as resolveStorePath } from "../../config/sessions.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../../config/sessions/session-accessor.sqlite-participants.native.js";
import * as sessionHistoryWorkers from "../../config/sessions/session-history-worker-runtime.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { observeSessionRowBackfill } from "../session-row-backfill.test-support.js";
import { rolePolicyConfig } from "../session-sharing.test-utils.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import {
  directSessionReq,
  seedLinearSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import {
  disposeSessionReadContexts,
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";

function roleConfig(
  others: "none" | "view" | "suggest" | "write",
  name = "limited",
  scopes = ["operator.read", "operator.write"],
): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: name,
        definitions: {
          [name]: { sessions: { others }, agents: "*", scopes },
        },
      },
    },
  };
}

async function seedTranscript(
  agentId: string,
  sessionKey: string,
  sessionId: string,
  ownerId: string,
  contents: string[],
  overrides: Partial<SessionEntry> = {},
) {
  const scope = { agentId, sessionKey, storePath: resolveStorePath(undefined, { agentId }) };
  await replaceSessionEntry(scope, {
    sessionId,
    updatedAt: Date.now(),
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id: ownerId },
    ...overrides,
  });
  await seedLinearSessionTranscript({ ...scope, sessionId, contents });
  return scope;
}

setupGatewaySessionsHandlerTestHarness();
afterEach(async () => {
  await disposeSessionReadContexts();
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

test("projects recap eligibility from current sharing authority, including capped shared viewers", async () => {
  const now = Date.now();
  using _ = vi.spyOn(Date, "now").mockReturnValue(now);
  const ownerId = ensureProfileForEmail("recap-reader@example.test").id;
  setUserProfileRole(ownerId, "view");
  const client = identifiedClient(ownerId);
  const foreignId = ensureProfileForEmail("recap-owner@example.test").id;
  const storePath = resolveStorePath(undefined, { agentId: "main" });
  for (const [name, creator, visibility] of [
    ["own", ownerId, "draft"],
    ["member", foreignId, "read-only"],
    ["viewer", foreignId, "shared"],
  ] as const) {
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: `agent:main:recap-${name}`, storePath },
      {
        sessionId: `recap-${name}`,
        updatedAt: now,
        visibility,
        createdActor: { type: "human", source: "profile", id: creator },
      },
    );
  }
  addSessionMember(
    { agentId: "main", sessionKey: "agent:main:recap-member", storePath },
    { identityId: ownerId, addedBy: foreignId },
  );
  for (const capped of [true, false]) {
    const context = requestContext(capped ? rolePolicyConfig() : {});
    const result = await listSessions({
      client,
      context,
      request: { includeActivitySummary: true },
    });
    const sessions = new Map(result.sessions.map((session) => [session.key, session]));
    for (const [name, sharingRole, canEnsure] of [
      ["own", "owner", true],
      ["member", "member", true],
      ["viewer", "viewer", !capped],
    ] as const) {
      expect(sessions.get(`agent:main:recap-${name}`)).toMatchObject({
        sharingRole,
        activitySummary: { canEnsure },
      });
    }
    expect(sessions.get("agent:main:recap-viewer")?.visibility).toBe("shared");
    for (const includeActivitySummary of [undefined, false]) {
      const ordinary = await listSessions({ client, context, request: { includeActivitySummary } });
      expect(ordinary.sessions).toEqual(
        result.sessions.map(({ activitySummary: _summary, ...row }) => row),
      );
    }
  }
});

test.each([
  { sessionKey: "global", transcript: false },
  { sessionKey: "unknown", transcript: false },
  { sessionKey: "global", transcript: true },
  { sessionKey: "unknown", transcript: true },
])(
  "keeps the selected unscoped $sessionKey row's owner (transcript=$transcript)",
  async ({ sessionKey, transcript }) => {
    const ownerId = ensureProfileForEmail("aggregate-owner@example.test").id;
    const cfg: OpenClawConfig = {
      session: { scope: "global" },
      agents: {
        entries: {
          main: { model: { primary: "openai/gpt-5.4" } },
          research: { model: { primary: "openai/gpt-5.5" } },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const sessionId = `aggregate-${sessionKey}`;
    await seedTranscript(
      "research",
      sessionKey,
      sessionId,
      ownerId,
      ["Research transcript title", "Research latest message"],
      { displayName: "Research transcript title", visibility: "draft" },
    );
    const client = identifiedClient(ownerId);
    const context = requestContext(cfg);
    const request = {
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: transcript,
      includeLastMessage: transcript,
    };
    if (transcript) {
      const backfilled = observeSessionRowBackfill([sessionKey]);
      await initializeSessionReadContext(context);
      await backfilled;
    }
    const result = await listSessions({ client, context, request });
    expect.soft(result.sessions).toHaveLength(1);
    expect.soft(result.sessions[0]).toMatchObject({
      key: sessionKey,
      sessionId,
      agentId: "research",
      modelProvider: "openai",
      model: "gpt-5.5",
      ...(transcript
        ? {
            derivedTitle: "Research transcript title",
            lastMessagePreview: "Research latest message",
          }
        : {}),
      visibility: "draft",
      sharingRole: "owner",
    });
    const searched = await listSessions({
      client,
      context,
      request: { ...request, search: "gpt-5.5" },
    });
    expect.soft(searched.sessions.map((row) => row.sessionId)).toEqual([sessionId]);
    if (sessionKey === "global") {
      const scoped = await listSessions({
        client,
        context,
        request: { ...request, agentId: "research" },
      });
      expect(scoped.sessions[0]).toMatchObject({
        agentId: "research",
        model: "gpt-5.5",
        visibility: "draft",
        sharingRole: "owner",
      });
    }
  },
);

test("a hidden-foreign role cannot discover sessions through search, batch previews, or exact resolve", async () => {
  const cfg = roleConfig("none", "guest");
  setRuntimeConfigSnapshot(cfg);
  const ownerId = ensureProfileForEmail("role-viewer@example.com").id;
  const foreignKey = "agent:main:foreign-role-read";
  const ownKey = "agent:main:own-role-read";
  for (const [sessionKey, actorId] of [
    [foreignKey, "foreign-owner@example.com"],
    [ownKey, ownerId],
  ] as const) {
    const sessionId = `session-${sessionKey.split(":").at(-1)}`;
    await seedTranscript("main", sessionKey, sessionId, actorId, ["hidden role search needle"]);
  }
  const client = identifiedClient(ownerId);
  const options = { client, context: { getRuntimeConfig: () => cfg } };
  const profiles = await prepareUserProfileCatalog();
  onTestFinished(profiles.release);

  const searched = await directSessionReq<{ results: Array<{ sessionKey: string }> }>(
    "sessions.search",
    { query: "hidden role search needle" },
    options,
  );
  expect(searched.payload?.results.map((result) => result.sessionKey)).toEqual([ownKey]);

  const listed = await listSessions({
    client,
    context: requestContext(cfg),
    request: { search: "direct", includePeople: true },
  });
  expect(listed.sessions.map((row) => row.key)).toEqual([ownKey]);
  expect(listed).toMatchObject({ count: 1, totalCount: 1, peopleSessionCount: 1 });
  expect(JSON.stringify(listed)).not.toMatch(/foreign-role-read|foreign-owner/);

  const previews = await directSessionReq<{
    previews: Array<{ key: string; status: string }>;
  }>("sessions.preview", { keys: [foreignKey, ownKey] }, options);
  expect(previews.payload?.previews).toMatchObject([
    { key: foreignKey, status: "missing" },
    { key: ownKey, status: "ok" },
  ]);

  const resolved = await directSessionReq("sessions.resolve", { key: foreignKey }, options);
  expect(resolved).toMatchObject({
    ok: false,
    error: { message: `No session found: ${foreignKey}` },
  });
});

test.each(["research", "ops"] as const)(
  "searches an explicit global row using its selected owner for %s visibility",
  async (viewer) => {
    const cfg: OpenClawConfig = {
      ...roleConfig("none", "reader", ["operator.read"]),
      session: { scope: "global" },
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };
    setRuntimeConfigSnapshot(cfg);
    const profiles = {
      ops: ensureProfileForEmail("search-ops@example.test").id,
      research: ensureProfileForEmail("search-research@example.test").id,
    };
    for (const agentId of ["ops", "research"] as const) {
      const sessionId = `global-search-${agentId}`;
      await seedTranscript(agentId, "global", sessionId, profiles[agentId], [
        "global owner search needle",
      ]);
    }
    const catalog = await prepareUserProfileCatalog();
    onTestFinished(catalog.release);
    const searched = await directSessionReq<{ results: Array<{ sessionKey: string }> }>(
      "sessions.search",
      { query: "global owner search needle", sessionKeys: ["global"], agentId: "research" },
      {
        client: identifiedClient(profiles[viewer]),
        context: { getRuntimeConfig: () => cfg },
      },
    );
    expect(searched.ok).toBe(true);
    expect(searched.payload?.results.map((result) => result.sessionKey)).toEqual(
      viewer === "research" ? ["global"] : [],
    );
  },
);

test("sessions.describe preserves caller roles and sessions.get hides foreign drafts", async () => {
  setRuntimeConfigSnapshot({});
  const sessionKey = "agent:main:foreign-draft-describe";
  const sessionId = "session-foreign-draft-describe";
  const profileId = (name: string) => ensureProfileForEmail(`${name}@example.com`).id;
  const profileClient = (name: string) => identifiedClient(profileId(name));
  const ownerId = profileId("draft-owner");
  const memberId = profileId("draft-member");
  const scope = await seedTranscript(
    "main",
    sessionKey,
    sessionId,
    ownerId,
    ["foreign draft transcript"],
    { visibility: "draft" },
  );
  const writeSession = (patch: Partial<SessionEntry>) =>
    replaceSessionEntry(scope, {
      sessionId,
      updatedAt: Date.now(),
      createdActor: { type: "human", source: "profile", id: ownerId },
      visibility: "shared",
      ...patch,
    });
  addSessionMember(scope, { identityId: memberId, addedBy: ownerId, addedAt: 1 });
  for (let index = 0; index < 5; index += 1) {
    recordSessionParticipant(scope, {
      identity: { type: "profile", id: `participant-${index}` },
      promptedAt: index + 1,
    });
  }
  const admin = profileClient("draft-admin");
  admin.connect!.scopes = ["operator.admin"];
  const missingProfile = profileClient("draft-missing-profile");
  const cases = [
    ["view", profileClient("draft-viewer"), roleConfig("view"), true, "viewer"],
    ["suggest", profileClient("draft-suggester"), roleConfig("suggest"), true, "viewer"],
    ["write", profileClient("draft-writer"), roleConfig("write"), true, "member"],
    ["member", identifiedClient(memberId), roleConfig("view"), true, "member"],
    ["missing profile", missingProfile, roleConfig("view"), true, null],
    ["owner", identifiedClient(ownerId), roleConfig("view"), false, "owner"],
    ["admin", admin, roleConfig("view"), false, "admin"],
    ["no roles", profileClient("draft-outsider"), {}, false, "viewer"],
  ] as const;
  const [, viewerClient, viewerConfig] = cases[0];
  delete missingProfile.authenticatedUserProfile;
  delete missingProfile.preparedSessionProfile;

  type Description = { session: GatewaySessionRow | null };
  type Transcript = { messages: Array<{ content?: unknown }> };
  const read = <T>(
    method: "sessions.describe" | "sessions.get",
    client: ReturnType<typeof identifiedClient>,
    getRuntimeConfig: () => OpenClawConfig,
  ) => directSessionReq<T>(method, { key: sessionKey }, { client, context: { getRuntimeConfig } });
  for (const [name, client, cfg, hidden, sharedRole] of cases) {
    const described = await read<Description>("sessions.describe", client, () => cfg);
    expect(described.ok, name).toBe(true);
    if (hidden) {
      expect(described.payload?.session, name).toBeNull();
    } else {
      expect
        .soft(described.payload?.session, name)
        .toMatchObject({ sharingRole: sharedRole, visibility: "draft" });
      expect(described.payload?.session?.participants, name).toHaveLength(4);
      expect(described.payload?.session?.expandedParticipants, name).toHaveLength(5);
    }
    const transcript = await read<Transcript>("sessions.get", client, () => cfg);
    expect(transcript.ok, name).toBe(true);
    expect(
      transcript.payload?.messages.map((message) => message.content),
      name,
    ).toEqual(hidden ? [] : ["foreign draft transcript"]);
  }

  await patchSessionEntryCore(scope, () => ({
    visibility: "shared",
  }));
  for (const [name, client, cfg, , sharedRole] of cases) {
    const described = await read<Description>("sessions.describe", client, () => cfg);
    expect(described.ok, name).toBe(true);
    if (sharedRole === null) {
      expect(described.payload?.session, name).toBeNull();
    } else {
      expect
        .soft(described.payload?.session, name)
        .toMatchObject({ sharingRole: sharedRole, visibility: "shared" });
    }
  }

  let describeCfg = roleConfig("write");
  const readCatalog = vi
    .fn(async () => ({ entries: [] }))
    .mockImplementationOnce(async () => {
      describeCfg = roleConfig("view");
      setRuntimeConfigSnapshot(describeCfg);
      return { entries: [] };
    });
  const describedAfterRoleChange = await directSessionReq<Description>(
    "sessions.describe",
    { key: sessionKey },
    {
      client: viewerClient,
      context: {
        getRuntimeConfig: () => describeCfg,
        readPreparedGatewayModelCatalog: readCatalog,
      },
    },
  );
  expect(describedAfterRoleChange.ok).toBe(true);
  expect(describedAfterRoleChange.payload?.session).toMatchObject({
    sharingRole: "viewer",
    visibility: "shared",
  });

  const originalRead = sessionHistoryWorkers.readSessionHistoryPageInWorker;
  for (const scenario of [
    { name: "visibility change", patch: { sessionId, visibility: "draft" as const } },
    {
      name: "session replacement",
      patch: { sessionId: `${sessionId}-replacement`, visibility: "shared" as const },
    },
    { name: "role/config change", patch: undefined },
  ]) {
    await writeSession(scenario.patch ? {} : { updatedAt: 44 });
    let currentCfg = viewerConfig;
    using _ = vi
      .spyOn(sessionHistoryWorkers, "readSessionHistoryPageInWorker")
      .mockImplementationOnce(async (...args) => {
        if (scenario.patch) {
          await writeSession({ ...scenario.patch, updatedAt: 43 });
        } else {
          currentCfg = roleConfig("none");
        }
        return await originalRead(...args);
      });
    const transcript = await read<Transcript>("sessions.get", viewerClient, () => currentCfg);
    expect(transcript.ok, scenario.name).toBe(true);
    expect(transcript.payload?.messages, scenario.name).toEqual([]);
  }
});
