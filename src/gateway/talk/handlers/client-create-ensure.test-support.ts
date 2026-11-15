import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target-paths.js";
import * as sqliteTarget from "../../../config/sessions/session-sqlite-target.js";
import { readDatabasePathIdentitySync } from "../../../infra/sqlite-worker-identity.js";
import type { SqliteWorkerAdmissionRequest } from "../../../infra/sqlite-worker-operation-admission.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { prepareUserProfileCatalog } from "../../../state/user-profile-list.js";
import { setDisplayName, setUserProfileRole } from "../../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import * as voiceWriters from "../../../talk/client-voice-session-write.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { captureGatewayDeviceRevocation } from "../../device-revocation.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  bindWebSocketRequestMutationAuthority,
} from "../../server-methods/session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import { SharedGatewaySessionGenerationState } from "../../server-shared-auth-generation.js";
import { resolveSessionMutationAuthorizationAsync } from "../../session-sharing-authorization-async.js";
import * as sharingGrants from "../../session-sharing-worker-grant.js";
import { rolePolicyConfig, sharingPolicyClient } from "../../session-sharing.test-utils.js";
import {
  browserSession,
  createDelegatedBrowserProviderFixture,
  type BrowserRequest,
  observeTalkVoiceChangeRequest,
} from "./client-fixtures.test-support.js";
import { talkVoiceHandlers } from "./voice.js";

export type EnsureHarness = {
  tempDir: () => string;
  ownVoice: (id: string | undefined, key: string) => void;
  configureProvider: (
    create: (request: BrowserRequest) => Promise<typeof browserSession>,
  ) => ReturnType<typeof createDelegatedBrowserProviderFixture>;
  invokeCreate: (options: GatewayRequestHandlerOptions) => Promise<void>;
  observeAdmission: (
    observer: ((request: SqliteWorkerAdmissionRequest, run: () => void) => void) | undefined,
  ) => void;
};

export async function authorizeBrowserCreate(
  options: GatewayRequestHandlerOptions,
  retain = false,
) {
  const admission = await resolveSessionMutationAuthorizationAsync({
    method: "talk.client.create",
    requestParams: options.params,
    context: options.context,
    client: options.client,
  });
  const handler = { ...options, sessionMutationAuthorization: admission.authorization };
  return {
    ...admission,
    handler:
      retain && !admission.error
        ? bindGatewayRequestHandlerMutationAuthority(options, handler, undefined)
        : handler,
  };
}

export function browserAuthority(
  context: object,
  client: Parameters<typeof bindWebSocketRequestMutationAuthority>[1],
) {
  const lifetime = captureGatewayDeviceRevocation(context, {}, () => true);
  const generation = new SharedGatewaySessionGenerationState({
    current: undefined,
    required: undefined,
  });
  return {
    ...lifetime,
    [Symbol.dispose]: lifetime.release,
    bind(options: GatewayRequestHandlerOptions) {
      options.hasCurrentClientAuthority = lifetime.isCurrent;
      return bindWebSocketRequestMutationAuthority(options, client, generation.reader);
    },
  };
}

export function createBrowserHarness(
  harness: Pick<EnsureHarness, "configureProvider" | "invokeCreate">,
  params: Record<string, unknown>,
  provider: (request: BrowserRequest) => Promise<typeof browserSession> = async () =>
    browserSession,
) {
  const createBrowserSession = vi.fn(provider);
  const fixture = harness.configureProvider(createBrowserSession);
  const respond = vi.fn();
  return {
    ...fixture,
    respond,
    createBrowserSession,
    get reply() {
      return respond.mock.lastCall;
    },
    create: (
      overrides: Record<string, unknown> = {},
      options: Partial<GatewayRequestHandlerOptions> = {},
    ) =>
      harness.invokeCreate({
        params: { ...params, ...overrides },
        respond,
        context: fixture.context,
        client: fixture.client,
        ...options,
      } as never),
  };
}

function observeTargetSql(targetPath: string, pattern: RegExp, enabled = () => true) {
  const targets = new Set([targetPath, readDatabasePathIdentitySync(targetPath).canonicalPath]);
  const queries: string[] = [];
  const observed = observeHostDataSql((sql, database) => {
    if (database && targets.has(database.location() ?? "") && enabled() && pattern.test(sql)) {
      queries.push(sql);
    }
  });
  return { ...observed, allQueries: observed.queries, queries };
}

export function requestBrowserVoiceChange(
  fixture: Pick<ReturnType<typeof createDelegatedBrowserProviderFixture>, "context" | "client">,
  voiceSessionId: string | undefined,
  prepare = (options: GatewayRequestHandlerOptions) => options,
) {
  const wait = observeTalkVoiceChangeRequest(fixture.context.broadcastToConnIds);
  const change = Promise.resolve(
    talkVoiceHandlers["talk.voice.set"]!(
      prepare({
        req: { type: "req", id: "voice-change", method: "talk.voice.set", params: {} },
        params: { voiceSessionId, voice: "ember" },
        respond: vi.fn(),
        context: fixture.context,
        client: fixture.client,
        isWebchatConnect: () => false,
      } as never),
    ),
  );
  const requested = wait(change).then(() => {
    const changeId = fixture.context.broadcastToConnIds.mock.calls.find(
      ([event]) => event === "talk.voice.change",
    )?.[1]?.changeId;
    expect(changeId).toBeTypeOf("string");
    return changeId;
  });
  return { change, requested };
}

export function registerClientCreateEnsureTests(harness: EnsureHarness) {
  const file = (name: string) => path.join(harness.tempDir(), name);
  const browser = (key: string, voiceSessionId?: string) =>
    createBrowserHarness(harness, {
      sessionKey: key,
      provider: "openai",
      ...(voiceSessionId ? { voiceSessionId } : {}),
    });
  const setStore = (fixture: ReturnType<typeof browser>, storePath: string) => {
    const cfg = fixture.context.getRuntimeConfig();
    fixture.context.getRuntimeConfig = () => ({ ...cfg, session: { store: storePath } });
  };
  const observeEnsuring = () => {
    let active = false;
    const ensure = voiceWriters.ensureClientVoiceAgentSessionEntry;
    vi.spyOn(voiceWriters, "ensureClientVoiceAgentSessionEntry").mockImplementation(
      async (...args) => {
        active = true;
        try {
          return await ensure(...args);
        } finally {
          active = false;
        }
      },
    );
    return () => active;
  };
  it.for([
    { change: "missing", phase: "preparation" },
    { change: "idless", phase: "preparation" },
    { change: "role", phase: "preparation" },
    { change: "role", phase: "publication" },
    { change: "display", phase: "publication" },
  ] as const)(
    "revalidates $change authority during entry $phase",
    async ({ change, phase }, { signal }) => {
      const entryChange = change === "missing" || change === "idless";
      const key = "agent:main:entry-" + change + "-" + phase;
      const scope = { agentId: "main", sessionKey: key };
      const voiceSessionId = entryChange ? "changed-entry-voice" : "profile-changed-voice";
      const fixture = browser(key, voiceSessionId);
      const profile = ensureProfileForEmail(
        entryChange ? "voice-entry-owner@example.test" : "voice-entry-profile@example.test",
      );
      setUserProfileRole(profile.id, "write");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      Object.assign(fixture.client, sharingPolicyClient({ user: profile.id }));
      const policy = rolePolicyConfig();
      if (!entryChange) {
        policy.gateway!.roles!.definitions.view!.agents = [];
      }
      const cfg = { ...policy, ...fixture.context.getRuntimeConfig() };
      fixture.context.getRuntimeConfig = () => cfg;
      const otherCreator = { type: "human", source: "profile", id: "another-profile" } as const;
      if (change === "idless") {
        await replaceSessionEntry(scope, {
          sessionId: "",
          updatedAt: 1,
          createdActor: otherCreator,
        });
      }
      let changed = false;
      const mutate = () => {
        if (entryChange) {
          replaceSessionEntrySync(scope, {
            sessionId: "",
            updatedAt: 2,
            visibility: "draft",
            createdActor: otherCreator,
          });
        } else if (change === "role") {
          setUserProfileRole(profile.id, "view");
        } else {
          setDisplayName(profile.id, "Changed display");
        }
        changed = true;
      };
      const prepared = createDeferred();
      const resume = createDeferred();
      const prepare = sharingGrants.prepareSessionSharingWorkerGrant;
      const ensure = voiceWriters.ensureClientVoiceAgentSessionEntry;
      const interception =
        phase === "publication"
          ? vi
              .spyOn(voiceWriters, "ensureClientVoiceAgentSessionEntry")
              .mockImplementationOnce((params) =>
                ensure({
                  ...params,
                  onCommittedSource: (source, entry) => {
                    params.onCommittedSource?.(source, entry);
                    mutate();
                  },
                }),
              )
          : (() => {
              const spy = vi.spyOn(sharingGrants, "prepareSessionSharingWorkerGrant");
              return spy[entryChange ? "mockImplementation" : "mockImplementationOnce"](
                async (params) => {
                  const grant = await prepare(params);
                  if (entryChange) {
                    if (params.transactionSource) {
                      prepared.resolve();
                      await resume.promise;
                    }
                  } else {
                    mutate();
                  }
                  return grant;
                },
              );
            })();
      const pending = fixture.create();
      try {
        if (entryChange) {
          await withinTest(
            Promise.race([
              prepared.promise,
              pending.then(() => {
                throw new Error(
                  "Creation finished before its authority wait: " +
                    (fixture.reply?.[2]?.message ?? "no error response"),
                );
              }),
            ]),
            signal,
          );
          mutate();
          resume.resolve();
        }
        await pending;
        if (fixture.reply?.[0]) {
          harness.ownVoice(fixture.reply[1].voiceSessionId, key);
        }
        expect(changed, fixture.reply?.[2]?.message).toBe(true);
        const entry = loadSessionEntry(scope);
        const record = clientVoiceSessionTesting.readRecord("main", voiceSessionId);
        if (entryChange) {
          expect(entry).toMatchObject({ sessionId: "", createdActor: { id: "another-profile" } });
          expect(record).toBeUndefined();
        } else {
          if (phase === "preparation") {
            expect(entry).toBeUndefined();
          } else {
            expect(entry?.sessionId).toBeTruthy();
          }
          expect(record?.status).toBe(change === "display" ? "open" : undefined);
        }
        expect(fixture.reply?.[0], fixture.reply?.[2]?.message).toBe(change === "display");
        expect(fixture.cancelBrowserSession).toHaveBeenCalledTimes(change === "display" ? 0 : 1);
      } finally {
        resume.resolve();
        try {
          await pending;
        } finally {
          interception.mockRestore();
        }
      }
    },
  );

  it.each(["missing-database", "idless"])(
    "commits the ensured %s chat in the worker before preparing voice authority",
    async (kind) => {
      const key = `agent:main:voice-${kind}`;
      harness.ownVoice(undefined, key);
      const idless = kind === "idless";
      const storePath = idless ? undefined : file("first-entry.sqlite");
      const creation = {
        createdVia: "internal" as const,
        createdAt: 7,
        createdActor: {
          type: "human" as const,
          source: "profile" as const,
          id: "original-creator",
        },
        sandbox: "required" as const,
      };
      if (idless) {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: key, storePath },
          { sessionId: "", updatedAt: 1, ...creation },
        );
      }
      const fixture = browser(key);
      if (storePath) {
        expect(existsSync(storePath)).toBe(false);
        setStore(fixture, storePath);
      }
      let entryTransactions = 0;
      harness.observeAdmission((request, run) => {
        const publication = isRecord(request.facts) ? request.facts.publication : undefined;
        if (isRecord(publication) && publication.kind === "session-entry-patch-validated") {
          entryTransactions += 1;
        }
        run();
      });
      const entryPath = storePath
        ? resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath).path
        : resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const hostSql = observeTargetSql(
        entryPath,
        /\b(?:create\s+(?:(?:unique|virtual)\s+)?(?:table|index|trigger|view)|alter\s+table|drop\s+(?:table|index|trigger|view)|quick_check|integrity_check)\b/i,
      );
      try {
        await fixture.create();
        expect(fixture.reply?.[0], JSON.stringify(fixture.reply?.[2])).toBe(true);
        const ownedVoiceSessionId = fixture.reply?.[1].voiceSessionId;
        harness.ownVoice(ownedVoiceSessionId, key);
        expect(
          hostSql.allQueries.filter((sql) =>
            /^\s*(?:insert(?:\s+or\s+\w+)?\s+into|update|delete\s+from)\s+"?session_nodes"?\b/i.test(
              sql,
            ),
          ),
        ).toEqual([]);
        expect(hostSql.queries).toEqual([]);
        expect(entryTransactions).toBe(1);
        const entry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
        expect(entry?.sessionId).toBeTruthy();
        if (idless) {
          expect(entry).toMatchObject(creation);
        }
        expect(clientVoiceSessionTesting.readRecord("main", ownedVoiceSessionId!)).toMatchObject({
          sessionKey: key,
          status: "open",
        });
      } finally {
        harness.observeAdmission(undefined);
        hostSql.restore();
      }
    },
  );

  it("keeps the committed chat when the following voice admission refuses", async () => {
    const key = "agent:main:ensure-before-voice-refusal";
    const voiceSessionId = "closed-before-ensure";
    await voiceSessions.createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: key,
      voiceSessionId,
      origin: "client",
    });
    await voiceSessions.closeClientVoiceSession({
      agentId: "main",
      sessionKey: key,
      voiceSessionId,
      config: {},
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toBeUndefined();
    const fixture = browser(key, voiceSessionId);
    await fixture.create();
    expect(fixture.respond).toHaveBeenLastCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("already closed") }),
    );
    expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toMatchObject({
      sessionId: expect.any(String),
      createdVia: "talk",
    });
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("closed");
    expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
  });

  it.each(["file", "directory-alias"])(
    "refuses a changed ensure target after discovery (%s)",
    async (change) => {
      const key = "agent:main:voice-ensure-race";
      const original = file("original");
      const successor = file("successor");
      const alias = file("selector");
      mkdirSync(original);
      mkdirSync(successor);
      symlinkSync(original, alias, "junction");
      openOpenClawAgentDatabase({ agentId: "other", path: path.join(original, "custom.sqlite") });
      const storePath = path.join(alias, "custom.json");
      const fixture = browser(key);
      setStore(fixture, storePath);
      const ensuring = observeEnsuring();
      let changed = false;
      let foreignPath: string | undefined;

      const resolve = sqliteTarget.prepareSqliteTargetFromSessionStorePath;
      vi.spyOn(sqliteTarget, "prepareSqliteTargetFromSessionStorePath").mockImplementation(
        async (...args) => {
          const target = await resolve(...args);
          if (ensuring() && !changed) {
            changed = true;
            if (change === "file") {
              foreignPath = target.path;
              writeFileSync(foreignPath, "foreign file appeared after discovery");
            } else {
              unlinkSync(alias);
              symlinkSync(successor, alias, "junction");
            }
          }
          return target;
        },
      );
      await fixture.create();
      expect(changed).toBe(true);
      expect(fixture.reply?.[0]).toBe(false);
      expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
      if (foreignPath) {
        expect(readFileSync(foreignPath, "utf8")).toBe("foreign file appeared after discovery");
      } else {
        expect(existsSync(path.join(successor, "custom.main.sqlite"))).toBe(false);
      }
    },
  );

  it.each([false, true])(
    "checks SDK authority before cold ensure admission (revoked=%s)",
    async (revoked) => {
      const key = "agent:main:voice-sdk-cold-ensure";
      const storePath = file("sdk-cold-ensure.sqlite");
      const fixture = browser(key);
      setStore(fixture, storePath);
      const ensuring = observeEnsuring();
      let checkedBeforeCreation = false;

      await fixture.create(
        {},
        {
          sessionMutationCommitGuard: () => {
            if (ensuring()) {
              checkedBeforeCreation ||= !existsSync(storePath);
              if (revoked) {
                throw new Error("SDK cold ensure authority revoked");
              }
            }
          },
        },
      );
      expect(checkedBeforeCreation).toBe(true);
      expect(fixture.reply?.[0], fixture.reply?.[2]?.message).toBe(!revoked);
      if (revoked) {
        expect(fixture.reply?.[2]?.message).toContain("SDK cold ensure authority revoked");
        expect(existsSync(storePath)).toBe(false);
        expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
      } else {
        harness.ownVoice(fixture.reply?.[1].voiceSessionId, key);
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.sessionId,
        ).toBeTruthy();
      }
    },
  );
}
