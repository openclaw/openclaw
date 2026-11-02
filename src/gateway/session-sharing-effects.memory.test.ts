import "../test-utils/prepare-compiled-subprocesses.js";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { withSessionActorStorage } from "../config/sessions/session-actor-storage-acquisition.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { sessionSuggestionHandlers } from "./server-methods/sessions-suggestions.js";
import { skillsLibraryHandlers } from "./server-methods/skills-library.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { sessionCompanionHandlers } from "./session-companion-rpc.js";
import type { SessionCompanionService } from "./session-companion.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory Gateway effects opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory Gateway effects allocated a worker");
  }),
}));
const projection = vi.hoisted(() => ({
  needsMembershipPreparation() {
    throw new Error("Incognito suggestions used durable membership discovery");
  },
  sharingTargetState() {
    throw new Error("Incognito suggestions used the durable row projection");
  },
}));
vi.mock("./session-row-projection-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-row-projection-access.js")>()),
  getSessionRowProjection: () => projection,
  requireSessionRowProjection: () => projection,
}));

const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-gateway-effects" };
const cfg = { agents: { entries: { main: {} } } };
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const location = {
  agentId: "main",
  path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
};
const handlers = {
  ...skillsLibraryHandlers,
  ...sessionSuggestionHandlers,
  ...sessionCompanionHandlers,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
});
afterEach(() => {
  memorySessionActorOwners.closeDatabase(location);
  vi.unstubAllEnvs();
  expect(DatabaseSync).not.toHaveBeenCalled();
  expect(Worker).not.toHaveBeenCalled();
});

async function fixture(name: string, fields: Partial<SessionEntry> = {}) {
  const scope = {
    agentId: "main",
    sessionKey: `agent:main:dashboard:incognito-${name}`,
    storePath: location.path,
    env,
  };
  const entry: SessionEntry = {
    sessionId: name,
    lifecycleRevision: name,
    updatedAt: 1,
    incognito: true,
    ...fields,
  };
  const created = await withSessionActorStorage(
    scope,
    { lifetime, authority, create: true },
    ({ actor }) =>
      actor.storage.mutate({ type: "session.entry.create", input: { entry } }, authority),
  );
  expect(created?.kind).toBe("committed");
  const client = sharingPolicyClient({ scopes: ["operator.admin"] });
  client.connId = "memory-effects-client";
  const context = createGatewayRequestContext(makeContextParams());
  context.getRuntimeConfig = () => cfg;
  context.getCommittedRuntimeConfig = () => cfg;
  context.isConnectionActive = () => true;
  const call = async (method: string, request: Record<string, unknown>) => {
    const params = { sessionKey: scope.sessionKey, ...request };
    const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
    await handlers[method]!({
      req: { type: "req", id: "memory-effects", method, params },
      params,
      client,
      context,
      isWebchatConnect: () => true,
      respond,
    });
    return respond;
  };
  const readEntry = () =>
    memorySessionActorOwners.read(location)?.readSession(scope.sessionKey, authority)?.entry;
  return { scope, client, context, call, readEntry };
}

function expectRefused(reply: Mock<GatewayRequestHandlerOptions["respond"]>, code: string) {
  expect(reply).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code }));
}

it("detaches a selected skill through the unbound Gateway handler without library storage", async () => {
  const skillId = "11111111-1111-4111-8111-111111111111";
  const { call, readEntry, scope } = await fixture("skill", {
    label: "Keep this label",
    skillLibrarySelections: [
      { skillId, revision: "a".repeat(64), name: "private-skill", ownerProfileId: null },
    ],
  });
  const response = await call("skills.library.activate", { action: "detach", skillId });
  expect(response).toHaveBeenCalledWith(
    true,
    { sessionKey: scope.sessionKey, selections: [], sessionActivation: "next-turn" },
    undefined,
  );
  expect(readEntry()).toMatchObject({ label: "Keep this label", skillLibrarySelections: [] });
});

it("adds and lists current incognito suggestions through Gateway effects without a durable projection", async () => {
  const { call, client, scope } = await fixture("suggestions", { visibility: "suggest" });
  client.authenticatedUserProfile = {
    profileId: "owner",
    displayName: "Owner",
    hasAvatar: false,
    updatedAt: 1,
  };
  const added = await call("session.suggestions.add", { text: "First suggestion" });
  expect(added).toHaveBeenCalledWith(true, {
    suggestion: expect.objectContaining({
      text: "First suggestion",
      state: "pending",
      sessionKey: scope.sessionKey,
    }),
  });
  const second = await call("session.suggestions.add", { text: "Second suggestion" });
  expect(second.mock.calls[0]?.[0]).toBe(true);
  const listed = await call("session.suggestions.list", {});
  expect(listed).toHaveBeenCalledWith(true, {
    role: "admin",
    suggestions: expect.arrayContaining([
      expect.objectContaining({
        text: "First suggestion",
        author: { type: "human", id: "owner", label: "Owner" },
      }),
      expect.objectContaining({ text: "Second suggestion" }),
    ]),
  });
  client.invalidated = true;
  const refused = await call("session.suggestions.list", {});
  expectRefused(refused, "FORBIDDEN");
});

it("withholds unbound companion disclosure after transport revocation", async () => {
  const { call, client, context } = await fixture("companion");
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  const ask = vi.fn<SessionCompanionService["ask"]>(async (request) => {
    request.assertSourceCurrent?.();
    entered.resolve();
    await finish.promise;
    return { answer: "Private answer", ts: 1 };
  });
  context.sessionCompanion = {
    ask,
    state: vi.fn<SessionCompanionService["state"]>(),
    reset: vi.fn(),
    dispose: vi.fn(),
  };
  const response = call("sessions.companion.ask", { question: "Explain the private session" });
  await Promise.race([
    entered.promise,
    response.then(() => {
      throw new Error("Companion request ended before reaching its effect");
    }),
  ]);
  client.invalidated = true;
  finish.resolve();
  const reply = await response;
  expect(ask).toHaveBeenCalledOnce();
  expectRefused(reply, "UNAVAILABLE");
  expect(reply.mock.calls.some(([ok]) => ok)).toBe(false);
});
