import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayErrorDetailCodes } from "../../packages/gateway-protocol/src/index.js";
import { withinTest } from "../../test/helpers/promise.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { withSessionActorStorage } from "../config/sessions/session-actor-storage-acquisition.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import * as profileReader from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { SessionCompanionAskError } from "./session-companion-errors.js";
import { sessionCompanionHandlers } from "./session-companion-rpc.js";
import type { SessionCompanionService } from "./session-companion.js";
import { roleClient, rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

const memoryOwners: Array<{ agentId: string; path: string }> = [];
afterEach(() => {
  for (const owner of memoryOwners.splice(0)) {
    memorySessionActorOwners.closeDatabase(owner);
  }
  closeOpenClawAgentDatabasesForTest();
});

async function invoke(
  method: "ask" | "state" | "reset",
  params: unknown,
  companion: Partial<Record<"ask" | "state" | "reset", ReturnType<typeof vi.fn>>>,
  {
    client = { connId: "conn-1" },
    signal,
    config = { agents: { entries: { main: {} } } },
  }: { client?: { connId?: string }; signal?: AbortSignal; config?: Record<string, unknown> } = {},
) {
  const respond = vi.fn();
  await sessionCompanionHandlers[`sessions.companion.${method}`]?.({
    params,
    client,
    context: { sessionCompanion: companion, getRuntimeConfig: () => config },
    respond,
    signal,
  } as never);
  return respond;
}
const askParams = { sessionKey: "agent:main:main", question: "Why?" };
const success = (respond: ReturnType<typeof vi.fn>, result: unknown) =>
  expect(respond).toHaveBeenCalledWith(true, result);

const withProfiles = (run: () => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    await captureRuntimeConfigAsyncReader()();
    await run();
  });
function expectError(respond: ReturnType<typeof vi.fn>, code: string, details = {}) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code, ...details }),
  );
}
const sessionEntry = (
  sessionId: string,
  profileId: string | undefined,
  visibility: "draft" | "shared" = "draft",
) => ({
  sessionId,
  updatedAt: 1,
  visibility,
  createdActor: { type: "human" as const, source: "profile" as const, id: profileId },
});
const createDraft = (sessionKey: string, sessionId: string, profileId: string | undefined) =>
  upsertSessionEntryCore({ agentId: "main", sessionKey }, sessionEntry(sessionId, profileId));
const viewer = (label: string, connId: string) => ({ ...roleClient("view", label), connId });

it("keeps a memory incognito source current through operator authority for durable side chat writes", () =>
  withProfiles(async () => {
    const profile = ensureProfileForEmail("incognito-companion@example.test");
    const client = {
      ...sharingPolicyClient({ user: profile.id, scopes: ["operator.admin"] }),
      connId: "incognito-companion-connection",
    };
    const sessionKey = "agent:main:dashboard:incognito-companion-source";
    const location = {
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    };
    memoryOwners.push(location);
    const created = await withSessionActorStorage(
      { agentId: "main", sessionKey, storePath: location.path },
      {
        lifetime: { assertCurrent() {}, assertReadable() {} },
        authority: { assertCurrent() {}, authorize() {} },
        create: true,
      },
      () =>
        upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            ...sessionEntry("incognito-companion-source", profile.id, "shared"),
            updatedAt: Date.now(),
            incognito: true,
          },
        ),
    );
    expect(created?.sessionId).toBe("incognito-companion-source");
    const target = { agentId: "main", sessionKey: "agent:main:companion-durable-target" };
    await upsertSessionEntryCore(target, {
      sessionId: "companion-durable-target",
      updatedAt: 1,
      label: "before side chat",
    });
    const ask = vi.fn(async (request: Parameters<SessionCompanionService["ask"]>[0]) => {
      const authority = expectDefined(request.operatorAuthority, "Captured operator authority");
      expect(authority.profileId).toBe(profile.id);
      await patchSessionEntryCore(target, () => ({ label: "private source accepted" }), {
        workerGuard: { source: authority.assertCurrent },
      });
      return { answer: "Private source accepted.", ts: 125 };
    });
    const respond = await invoke(
      "ask",
      { sessionKey, question: "Summarize this private session." },
      { ask },
      { client },
    );

    expect(ask).toHaveBeenCalledOnce();
    success(respond, { answer: "Private source accepted.", ts: 125 });
    expect(loadSessionEntry(target)?.label).toBe("private source accepted");
  }));

it("carries the authenticated model policy and releases it after answering", async () => {
  const controller = new AbortController();
  await withProfiles(async () => {
    const client = viewer("companion-policy", "policy-connection");
    using _ = {
      [Symbol.dispose]: (await profileReader.prepareUserProfileCatalog()).release,
    };
    const cfg = rolePolicyConfig();
    cfg.agents = {
      entries: { main: {} },
      defaults: { model: "test-provider/allowed" },
    };
    const role = cfg.gateway?.roles?.definitions.view;
    if (!role) {
      throw new Error("The role fixture is missing its reader policy");
    }
    role.modelPolicy = { sourceAgent: "main" };
    const sessionKey = "agent:main:policy";
    await createDraft(sessionKey, "policy-session", client.authenticatedUserProfile?.profileId);
    let captured: AdmittedRunOperatorAuthority | undefined;
    const ask = vi.fn(async (request: Parameters<SessionCompanionService["ask"]>[0]) => {
      captured = request.operatorAuthority;
      expect(request.signal).toBe(controller.signal);
      expect(request.connId).toBe("policy-connection");
      expect(captured?.profileId).toBe(client.authenticatedUserProfile?.profileId);
      expect(captured?.modelPolicy?.models).toEqual([
        { provider: "test-provider", model: "allowed" },
      ]);
      captured?.assertCurrent();
      return { answer: "Allowed answer.", ts: 125 };
    });
    const respond = await invoke(
      "ask",
      { sessionKey, question: "What happened?" },
      { ask },
      { client, signal: controller.signal, config: cfg },
    );
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, { answer: "Allowed answer.", ts: 125 });
    expect(captured).toBeDefined();
    expect(() => captured?.assertCurrent()).toThrow("no longer active");
  });
});

it.each(["params", "connection"] as const)(
  "retains the original side chat request while profile preparation waits for %s",
  async (change) => {
    await withProfiles(async () => {
      const client = viewer(`companion-await-${change}`, "original-connection");
      const attachment = { mimeType: "image/png", content: "b3JpZ2luYWw=" };
      const params = {
        sessionKey: "agent:main:original",
        question: "Original question",
        attachments: [attachment],
      };
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const originalPrepare = profileReader.prepareUserProfileIdentity;
      const release = vi.fn();
      const spy = vi
        .spyOn(profileReader, "prepareUserProfileIdentity")
        .mockImplementation(async (...args) => {
          const prepared = await originalPrepare(...args);
          release.mockImplementation(prepared.release);
          prepared.release = release;
          entered.resolve();
          await resume.promise;
          return prepared;
        });
      const ask = vi.fn(async () => ({ answer: "Original answer", ts: 1 }));
      const running = invoke("ask", params, { ask }, { client });
      try {
        await entered.promise;
        if (change === "params") {
          params.sessionKey = "agent:main:replacement";
          params.question = "Replacement question";
          attachment.content = "cmVwbGFjZW1lbnQ=";
        } else {
          client.connId = "replacement-connection";
        }
        resume.resolve();
        const respond = await running;
        if (change === "params") {
          expect(ask).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              sessionKey: "agent:main:original",
              question: "Original question",
              connId: "original-connection",
              attachments: [{ mimeType: "image/png", content: "b3JpZ2luYWw=" }],
            }),
          );
          success(respond, { answer: "Original answer", ts: 1 });
        } else {
          expect(ask).not.toHaveBeenCalled();
          expectError(respond, "UNAVAILABLE");
        }
        expect(release).toHaveBeenCalledOnce();
      } finally {
        resume.resolve();
        await running;
        spy.mockRestore();
      }
    });
  },
);

it.each([
  ["invalid parameters", { ...askParams, extra: true }, { connId: "conn-1" }, "INVALID_REQUEST"],
  ["missing connection", askParams, {}, "FORBIDDEN"],
] as const)("rejects an ask with %s before dispatch", async (_, params, client, code) => {
  const ask = vi.fn();
  const respond = await invoke("ask", params, { ask }, { client });
  expect(ask).not.toHaveBeenCalled();
  expectError(respond, code);
});

it.each([
  { reason: "busy", details: { code: GatewayErrorDetailCodes.SESSION_COMPANION_BUSY } },
  { reason: "context-unavailable", details: { reason: "context-unavailable" } },
] as const)("returns the typed retryable $reason detail", async ({ reason, details }) => {
  const ask = vi.fn(async () => {
    throw new SessionCompanionAskError(reason, "Cannot answer yet.");
  });
  const respond = await invoke("ask", askParams, { ask });
  expectError(respond, "UNAVAILABLE", { retryable: true, details });
});

it.each(["state", "reset"] as const)(
  "dispatches and validates per-session %s",
  async (operation) => {
    const state = { exchanges: [{ question: "Why?", answer: "Because.", ts: 10 }] };
    const companion = { state: vi.fn(() => state), reset: vi.fn() };
    const respond = await invoke(operation, { sessionKey: askParams.sessionKey }, companion);
    expect(companion[operation]).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:main",
      ownerId: "shared",
    });
    success(respond, operation === "state" ? state : { ok: true });

    const invalid = await invoke(
      operation,
      operation === "state" ? {} : { sessionKey: "agent:main:main", extra: true },
      companion,
    );
    expectError(invalid, "INVALID_REQUEST");
  },
);

it("reads companion visibility while an unrelated writer remains admitted", async ({ signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    await captureRuntimeConfigAsyncReader()();
    const owner = ensureProfileForEmail("companion-owner@example.test");
    const client = viewer("companion-reader", "reader-connection");
    using _ = {
      [Symbol.dispose]: (await profileReader.prepareUserProfileCatalog()).release,
    };
    const cfg = rolePolicyConfig();
    cfg.agents = { entries: { main: {} } };
    const keys = ["agent:main:companion-shared", "agent:main:companion-draft"];
    for (const [index, visibility] of (["shared", "draft"] as const).entries()) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: keys[index]!, env },
        sessionEntry(`companion-${visibility}`, owner.id, visibility),
      );
    }
    const exchanges = [{ question: "Why?", answer: "Because.", ts: 10 }];
    const state = vi.fn(() => ({ exchanges }));
    const read = (sessionKey: string) =>
      invoke("state", { sessionKey }, { state }, { client, config: cfg });
    await read(keys[0]!);
    state.mockClear();

    const entered = createDeferredCore();
    const release = createDeferredCore();
    const writer = runOpenClawAgentWriteAdmission({ agentId: "main", env }, async () => {
      entered.resolve();
      await release.promise;
    });
    const reads: Array<ReturnType<typeof read>> = [];
    try {
      await withinTest(entered.promise, signal);
      reads.push(...keys.map(read));
      const results = await withinTest(Promise.all(reads), signal);
      const visible = expectDefined(results[0], "visible response");
      const hidden = expectDefined(results[1], "hidden response");
      success(visible, { exchanges });
      expectError(hidden, "INVALID_REQUEST");
      expect(state).toHaveBeenCalledExactlyOnceWith({
        agentId: "main",
        sessionKey: keys[0],
        ownerId: `profile:${client.authenticatedUserProfile?.profileId}`,
      });
    } finally {
      release.resolve();
      await Promise.allSettled([writer, ...reads]);
    }
  });
});

it.each(["ask", "state"] as const)(
  "hides a foreign draft before dispatching %s",
  async (method) => {
    await withProfiles(async () => {
      const owner = ensureProfileForEmail("owner@example.test");
      using _ = {
        [Symbol.dispose]: (await profileReader.prepareUserProfileCatalog()).release,
      };
      const sessionKey = "agent:main:owner-private";
      await createDraft(sessionKey, "owner-private-session", owner.id);
      const ask = vi.fn(async () => ({ answer: "private", ts: 1 }));
      const state = vi.fn(() => ({ exchanges: [] }));
      const respond = await invoke(
        method,
        { sessionKey, ...(method === "ask" ? { question: "Why?" } : {}) },
        { ask, state },
        {
          client: viewer("foreign-viewer", "viewer-connection"),
          config: rolePolicyConfig(),
        },
      );

      expect(ask).not.toHaveBeenCalled();
      expect(state).not.toHaveBeenCalled();
      expectError(respond, "INVALID_REQUEST");
    });
  },
);

it("addresses only the requester's own Side chat thread", async () => {
  const reset = vi.fn();
  const clients = [
    { connId: "conn-alice", authenticatedUserProfile: { profileId: "alice" } },
    { connId: "conn-bob", authenticatedUserProfile: { profileId: "bob" } },
    { connId: "conn-token" },
  ];
  for (const client of clients) {
    await invoke("reset", { sessionKey: "agent:main:main" }, { reset }, { client });
  }
  expect(reset.mock.calls.map(([target]) => target.ownerId)).toEqual([
    "profile:alice",
    "profile:bob",
    "shared",
  ]);
});

it("threads an explicit owner for a bare key and returns typed selection errors", async () => {
  const config = { agents: { ownership: "explicit", entries: { main: {}, work: {} } } };
  const state = vi.fn(() => ({ exchanges: [] }));
  const selected = await invoke(
    "state",
    { sessionKey: "global", agentId: "work" },
    { state },
    { config },
  );
  expect(state).toHaveBeenCalledWith({ agentId: "work", sessionKey: "global", ownerId: "shared" });
  success(selected, { exchanges: [] });

  state.mockClear();
  const ambiguous = await invoke("state", { sessionKey: "global" }, { state }, { config });
  expect(state).not.toHaveBeenCalled();
  expectError(ambiguous, "INVALID_REQUEST");
});
