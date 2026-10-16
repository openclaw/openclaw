import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayErrorDetailCodes } from "../../packages/gateway-protocol/src/index.js";
import { withinTest } from "../../test/helpers/promise.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { withSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
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
  method: keyof typeof sessionCompanionHandlers,
  params: unknown,
  companion: {
    ask?: ReturnType<typeof vi.fn>;
    state?: ReturnType<typeof vi.fn>;
    reset?: ReturnType<typeof vi.fn>;
  },
  client: { connId?: string } = { connId: "conn-1" },
  signal?: AbortSignal,
  config: Record<string, unknown> = { agents: { entries: { main: {} } } },
) {
  const respond = vi.fn();
  await sessionCompanionHandlers[method]?.({
    params,
    client,
    context: { sessionCompanion: companion, getRuntimeConfig: () => config },
    respond,
    signal,
  } as never);
  return respond;
}

describe("session companion RPC", () => {
  it("keeps a memory incognito source current through operator authority for durable side chat writes", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      await captureRuntimeConfigAsyncReader()();
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
              sessionId: "incognito-companion-source",
              updatedAt: Date.now(),
              incognito: true,
              visibility: "shared",
              createdActor: { type: "human", source: "profile", id: profile.id },
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
        // The captured authority composes the real RPC source through the operator owner.
        await patchSessionEntryCore(target, () => ({ label: "private source accepted" }), {
          workerGuard: { source: authority.assertCurrent },
        });
        return { answer: "Private source accepted.", ts: 125 };
      });
      const respond = await invoke(
        "sessions.companion.ask",
        { sessionKey, question: "Summarize this private session." },
        { ask },
        client,
      );

      expect(ask).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(true, { answer: "Private source accepted.", ts: 125 });
      expect(loadSessionEntry(target)?.label).toBe("private source accepted");
    });
  });

  it("carries the authenticated model policy and releases it after answering", async () => {
    const controller = new AbortController();
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      await captureRuntimeConfigAsyncReader()();
      const client = { ...roleClient("view", "companion-policy"), connId: "policy-connection" };
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
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "policy-session",
          updatedAt: 1,
          visibility: "draft",
          createdActor: {
            type: "human",
            source: "profile",
            id: client.authenticatedUserProfile?.profileId,
          },
        },
      );
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
        "sessions.companion.ask",
        { sessionKey, question: "What happened?" },
        { ask },
        client,
        controller.signal,
        cfg,
      );
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, { answer: "Allowed answer.", ts: 125 });
      expect(captured).toBeDefined();
      expect(() => captured?.assertCurrent()).toThrow("no longer active");
    });
  });

  it.each(["params", "connection"] as const)(
    "retains the original side chat request while profile preparation waits for %s",
    async (change) => {
      await withOpenClawTestState(
        { scenario: "minimal", prepareProfileCatalog: true },
        async () => {
          await captureRuntimeConfigAsyncReader()();
          const client = {
            ...roleClient("view", `companion-await-${change}`),
            connId: "original-connection",
          };
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
          const running = invoke("sessions.companion.ask", params, { ask }, client);
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
              expect(respond).toHaveBeenCalledWith(true, { answer: "Original answer", ts: 1 });
            } else {
              expect(ask).not.toHaveBeenCalled();
              expect(respond).toHaveBeenCalledWith(
                false,
                undefined,
                expect.objectContaining({ code: "UNAVAILABLE" }),
              );
            }
            expect(release).toHaveBeenCalledOnce();
          } finally {
            resume.resolve();
            await running;
            spy.mockRestore();
          }
        },
      );
    },
  );

  it.each([
    {
      name: "invalid parameters",
      params: { sessionKey: "agent:main:main", question: "Why?", extra: true },
      client: { connId: "conn-1" },
      code: "INVALID_REQUEST",
    },
    {
      name: "missing connection",
      params: { sessionKey: "agent:main:main", question: "Why?" },
      client: {},
      code: "FORBIDDEN",
    },
  ])("rejects an ask with $name before dispatch", async ({ params, client, code }) => {
    const ask = vi.fn();
    const respond = await invoke("sessions.companion.ask", params, { ask }, client);
    expect(ask).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code }));
  });

  it.each([
    { reason: "busy", details: { code: GatewayErrorDetailCodes.SESSION_COMPANION_BUSY } },
    { reason: "context-unavailable", details: { reason: "context-unavailable" } },
  ] as const)("returns the typed retryable $reason detail", async ({ reason, details }) => {
    const ask = vi.fn(async () => {
      throw new SessionCompanionAskError(reason, "Cannot answer yet.");
    });
    const respond = await invoke(
      "sessions.companion.ask",
      { sessionKey: "agent:main:main", question: "Why?" },
      { ask },
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
        details,
      }),
    );
  });

  it.each(["state", "reset"] as const)(
    "dispatches and validates per-session %s",
    async (operation) => {
      const state = { exchanges: [{ question: "Why?", answer: "Because.", ts: 10 }] };
      const companion = { state: vi.fn(() => state), reset: vi.fn() };
      const method = `sessions.companion.${operation}`;
      const respond = await invoke(method, { sessionKey: "agent:main:main" }, companion);
      expect(companion[operation]).toHaveBeenCalledWith({
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      expect(respond).toHaveBeenCalledWith(true, operation === "state" ? state : { ok: true });

      const invalid = await invoke(
        method,
        operation === "state" ? {} : { sessionKey: "agent:main:main", extra: true },
        companion,
      );
      expect(invalid).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    },
  );

  it("reads companion visibility while an unrelated writer remains admitted", async ({
    signal,
  }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      await captureRuntimeConfigAsyncReader()();
      const owner = ensureProfileForEmail("companion-owner@example.test");
      const client = { ...roleClient("view", "companion-reader"), connId: "reader-connection" };
      using _ = {
        [Symbol.dispose]: (await profileReader.prepareUserProfileCatalog()).release,
      };
      const cfg = rolePolicyConfig();
      cfg.agents = { entries: { main: {} } };
      const keys = ["agent:main:companion-shared", "agent:main:companion-draft"];
      for (const [index, visibility] of (["shared", "draft"] as const).entries()) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: keys[index]!, env },
          {
            sessionId: `companion-${visibility}`,
            updatedAt: 1,
            visibility,
            createdActor: { type: "human", source: "profile", id: owner.id },
          },
        );
      }
      const exchanges = [{ question: "Why?", answer: "Because.", ts: 10 }];
      const state = vi.fn(() => ({ exchanges }));
      const read = (sessionKey: string) =>
        invoke("sessions.companion.state", { sessionKey }, { state }, client, undefined, cfg);
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
        const [visible, hidden] = await withinTest(Promise.all(reads), signal);
        expect(visible).toHaveBeenCalledWith(true, { exchanges });
        expect(hidden).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        expect(state).toHaveBeenCalledExactlyOnceWith({
          agentId: "main",
          sessionKey: keys[0],
        });
      } finally {
        release.resolve();
        await Promise.allSettled([writer, ...reads]);
      }
    });
  });

  it.each(["sessions.companion.ask", "sessions.companion.state"] as const)(
    "hides a foreign draft before dispatching %s",
    async (method) => {
      await withOpenClawTestState(
        { scenario: "minimal", prepareProfileCatalog: true },
        async () => {
          await captureRuntimeConfigAsyncReader()();
          const owner = ensureProfileForEmail("owner@example.test");
          using _ = {
            [Symbol.dispose]: (await profileReader.prepareUserProfileCatalog()).release,
          };
          const sessionKey = "agent:main:owner-private";
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            {
              sessionId: "owner-private-session",
              updatedAt: 1,
              visibility: "draft",
              createdActor: { type: "human", source: "profile", id: owner.id },
            },
          );
          const ask = vi.fn(async () => ({ answer: "private", ts: 1 }));
          const state = vi.fn(() => ({ exchanges: [] }));
          const respond = await invoke(
            method,
            { sessionKey, ...(method === "sessions.companion.ask" ? { question: "Why?" } : {}) },
            { ask, state },
            { ...roleClient("view", "foreign-viewer"), connId: "viewer-connection" },
            undefined,
            rolePolicyConfig(),
          );

          expect(ask).not.toHaveBeenCalled();
          expect(state).not.toHaveBeenCalled();
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: "INVALID_REQUEST" }),
          );
        },
      );
    },
  );

  it("threads an explicit owner for a bare key and returns typed selection errors", async () => {
    const config = { agents: { ownership: "explicit", entries: { main: {}, work: {} } } };
    const state = vi.fn(() => ({ exchanges: [] }));
    const selected = await invoke(
      "sessions.companion.state",
      { sessionKey: "global", agentId: "work" },
      { state },
      undefined,
      undefined,
      config,
    );
    expect(state).toHaveBeenCalledWith({ agentId: "work", sessionKey: "global" });
    expect(selected).toHaveBeenCalledWith(true, { exchanges: [] });

    state.mockClear();
    const ambiguous = await invoke(
      "sessions.companion.state",
      { sessionKey: "global" },
      { state },
      undefined,
      undefined,
      config,
    );
    expect(state).not.toHaveBeenCalled();
    expect(ambiguous).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
