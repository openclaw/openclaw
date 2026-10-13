import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { setUserProfileRole } from "../../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import * as voiceWriters from "../../../talk/client-voice-session-write.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import * as sharingGrants from "../../session-sharing-worker-grant.js";
import { rolePolicyConfig, sharingPolicyClient } from "../../session-sharing.test-utils.js";
import {
  browserSession,
  createDelegatedBrowserProviderFixture,
  type BrowserRequest,
} from "./client-fixtures.test-support.js";

type EnsureHarness = {
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

export function registerClientCreateEnsureTests(harness: EnsureHarness) {
  it.for(["missing", "idless"] as const)(
    "refuses a changed %s entry while its transaction authority is being prepared",
    async (kind, { signal }) => {
      const key = `agent:main:entry-authority-${kind}`;
      const scope = { agentId: "main", sessionKey: key };
      const fixture = harness.configureProvider(async () => browserSession);
      const profile = ensureProfileForEmail("voice-entry-owner@example.test");
      setUserProfileRole(profile.id, "write");
      Object.assign(fixture.client, sharingPolicyClient({ user: profile.id }));
      const cfg = { ...rolePolicyConfig(), ...fixture.context.getRuntimeConfig() };
      fixture.context.getRuntimeConfig = () => cfg;
      if (kind === "idless") {
        await replaceSessionEntry(scope, {
          sessionId: "",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "another-profile" },
        });
      }
      const prepared = createDeferred();
      const resume = createDeferred();
      const prepare = sharingGrants.prepareSessionSharingWorkerGrant;
      const preparation = vi
        .spyOn(sharingGrants, "prepareSessionSharingWorkerGrant")
        .mockImplementation(async (params) => {
          const grant = await prepare(params);
          if (params.transactionSource) {
            prepared.resolve();
            await resume.promise;
          }
          return grant;
        });
      const respond = vi.fn();
      const pending = harness.invokeCreate({
        params: { sessionKey: key, provider: "openai", voiceSessionId: "changed-entry-voice" },
        respond,
        context: fixture.context,
        client: fixture.client,
      } as never);
      try {
        await withinTest(
          Promise.race([
            prepared.promise,
            pending.then(() => {
              throw new Error("Creation finished before its authority wait");
            }),
          ]),
          signal,
        );
        replaceSessionEntrySync(scope, {
          sessionId: "",
          updatedAt: 2,
          visibility: "draft",
          createdActor: { type: "human", source: "profile", id: "another-profile" },
        });
        resume.resolve();
        await pending;
        if (respond.mock.lastCall?.[0]) {
          harness.ownVoice(respond.mock.lastCall[1].voiceSessionId, key);
        }
        expect(respond.mock.lastCall?.[0]).toBe(false);
        expect(loadSessionEntry(scope)?.sessionId).toBe("");
        expect(loadSessionEntry(scope)?.createdActor?.id).toBe("another-profile");
        expect(clientVoiceSessionTesting.readRecord("main", "changed-entry-voice")).toBeUndefined();
        expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
      } finally {
        resume.resolve();
        await pending;
        preparation.mockRestore();
      }
    },
  );

  it.each([
    { change: "role", phase: "publication", writer: "foreign" },
    { change: "display", phase: "publication", writer: "foreign" },
    { change: "role", phase: "preparation", writer: "owner" },
  ] as const)(
    "rechecks a $writer profile $change commit after entry $phase",
    async ({ change, phase }) => {
      const key = `agent:main:entry-profile-${change}-${phase}`;
      const fixture = harness.configureProvider(async () => browserSession);
      const profile = ensureProfileForEmail("voice-entry-profile@example.test");
      setUserProfileRole(profile.id, "write");
      Object.assign(fixture.client, sharingPolicyClient({ user: profile.id }));
      const policy = rolePolicyConfig();
      policy.gateway!.roles!.definitions.view!.agents = [];
      const cfg = { ...policy, ...fixture.context.getRuntimeConfig() };
      fixture.context.getRuntimeConfig = () => cfg;
      const ensure = voiceWriters.ensureClientVoiceAgentSessionEntry;
      let changed = false;
      const changeProfile = () => {
        if (phase === "preparation") {
          setUserProfileRole(profile.id, "view");
          changed = true;
          return;
        }
        const peer = new DatabaseSync(resolveOpenClawStateSqlitePath());
        try {
          peer
            .prepare(
              change === "role"
                ? "UPDATE user_profiles SET role = 'view' WHERE id = ?"
                : "UPDATE user_profiles SET display_name = 'Changed display' WHERE id = ?",
            )
            .run(profile.id);
          changed = true;
        } finally {
          peer.close();
        }
      };
      const prepare = sharingGrants.prepareSessionSharingWorkerGrant;
      const creation =
        phase === "preparation"
          ? vi
              .spyOn(sharingGrants, "prepareSessionSharingWorkerGrant")
              .mockImplementationOnce(async (params) => {
                const grant = await prepare(params);
                changeProfile();
                return grant;
              })
          : vi
              .spyOn(voiceWriters, "ensureClientVoiceAgentSessionEntry")
              .mockImplementationOnce((params) =>
                ensure({
                  ...params,
                  onCommittedSource: (source, entry) => {
                    params.onCommittedSource?.(source, entry);
                    changeProfile();
                  },
                }),
              );
      const respond = vi.fn();
      try {
        await harness.invokeCreate({
          params: { sessionKey: key, provider: "openai", voiceSessionId: "profile-changed-voice" },
          respond,
          context: fixture.context,
          client: fixture.client,
        } as never);
        expect(changed).toBe(true);
        const entry = loadSessionEntry({ agentId: "main", sessionKey: key });
        if (phase === "preparation") {
          expect(entry).toBeUndefined();
        } else {
          expect(entry?.sessionId).toBeTruthy();
        }
        if (respond.mock.lastCall?.[0]) {
          harness.ownVoice(respond.mock.lastCall[1].voiceSessionId, key);
        }
        expect(respond.mock.lastCall?.[0], respond.mock.lastCall?.[2]?.message).toBe(
          change === "display",
        );
        expect(clientVoiceSessionTesting.readRecord("main", "profile-changed-voice")?.status).toBe(
          change === "display" ? "open" : undefined,
        );
        expect(fixture.cancelBrowserSession).toHaveBeenCalledTimes(change === "role" ? 1 : 0);
      } finally {
        creation.mockRestore();
      }
    },
  );

  it.each([
    "missing",
    "idless",
    "missing-database",
    "missing-suffix",
    "idless-suffix",
    "missing-gap-suffix",
  ])("commits the ensured %s chat in the worker before preparing voice authority", async (kind) => {
    const key = `agent:main:voice-${kind}`;
    harness.ownVoice(undefined, key);
    const suffix = kind.endsWith("-suffix");
    const idless = kind.startsWith("idless");
    const suffixPath = path.join(
      harness.tempDir(),
      kind === "missing-gap-suffix" ? "custom.main.2.sqlite" : "custom.main.sqlite",
    );
    const storePath = suffix
      ? path.join(harness.tempDir(), "custom.json")
      : kind === "missing-database"
        ? path.join(harness.tempDir(), "first-entry.sqlite")
        : undefined;
    if (suffix) {
      openOpenClawAgentDatabase({
        agentId: "other",
        path: path.join(harness.tempDir(), "custom.sqlite"),
      });
      expect(existsSync(path.join(harness.tempDir(), "custom.main.sqlite"))).toBe(false);
    }
    if (kind === "missing-gap-suffix") {
      const reservedPath = path.join(harness.tempDir(), "custom.main.sqlite");
      openOpenClawAgentDatabase({ agentId: "reserved", path: reservedPath });
      await closeOpenClawAgentDatabasesAsync();
      unlinkSync(reservedPath);
    }
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
    const fixture = harness.configureProvider(async () => browserSession);
    if (storePath) {
      if (!suffix) {
        expect(existsSync(storePath)).toBe(false);
      }
      const cfg = fixture.context.getRuntimeConfig();
      fixture.context.getRuntimeConfig = () => ({
        ...cfg,
        session: { store: storePath },
      });
    }
    let entryTransactions = 0;
    harness.observeAdmission((request, run) => {
      const publication = isRecord(request.facts) ? request.facts.publication : undefined;
      if (isRecord(publication) && publication.kind === "session-entry-patch-validated") {
        entryTransactions += 1;
      }
      run();
    });
    const entryPath = suffix
      ? suffixPath
      : storePath
        ? resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath).path
        : resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const targetPaths = new Set([entryPath, readDatabasePathIdentitySync(entryPath).canonicalPath]);
    const targetSchemaSql: string[] = [];
    const hostSql = observeHostDataSql((sql, database) => {
      if (
        database &&
        targetPaths.has(database.location() ?? "") &&
        /\b(?:create\s+(?:(?:unique|virtual)\s+)?(?:table|index|trigger|view)|alter\s+table|drop\s+(?:table|index|trigger|view)|quick_check|integrity_check)\b/i.test(
          sql,
        )
      ) {
        targetSchemaSql.push(sql);
      }
    });
    const respond = vi.fn();
    try {
      await harness.invokeCreate({
        params: { sessionKey: key, provider: "openai" },
        respond,
        context: fixture.context,
        client: fixture.client,
      } as never);
      expect(respond.mock.lastCall?.[0]).toBe(true);
      const ownedVoiceSessionId = respond.mock.lastCall?.[1].voiceSessionId;
      harness.ownVoice(ownedVoiceSessionId, key);
      expect(
        hostSql.queries.filter((sql) =>
          /^\s*(?:insert(?:\s+or\s+\w+)?\s+into|update|delete\s+from)\s+"?session_nodes"?\b/i.test(
            sql,
          ),
        ),
      ).toEqual([]);
      expect(targetSchemaSql).toEqual([]);
      expect(entryTransactions).toBe(1);
      const entry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
      expect(entry?.sessionId).toBeTruthy();
      if (idless) {
        expect(entry).toMatchObject(creation);
      }
      if (suffix) {
        expect(existsSync(suffixPath)).toBe(true);
        expect(
          loadSessionEntry({
            agentId: "other",
            sessionKey: key,
            storePath: path.join(harness.tempDir(), "custom.sqlite"),
          }),
        ).toBeUndefined();
      }
      expect(clientVoiceSessionTesting.readRecord("main", ownedVoiceSessionId!)).toMatchObject({
        sessionKey: key,
        status: "open",
      });
    } finally {
      harness.observeAdmission(undefined);
      hostSql.restore();
    }
  });

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
    const fixture = harness.configureProvider(async () => browserSession);
    const respond = vi.fn();
    await harness.invokeCreate({
      params: { sessionKey: key, provider: "openai", voiceSessionId },
      respond,
      context: fixture.context,
      client: fixture.client,
    } as never);
    expect(respond).toHaveBeenLastCalledWith(
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
      const original = path.join(harness.tempDir(), "original");
      const successor = path.join(harness.tempDir(), "successor");
      const alias = path.join(harness.tempDir(), "selector");
      mkdirSync(original);
      mkdirSync(successor);
      symlinkSync(original, alias, "junction");
      openOpenClawAgentDatabase({ agentId: "other", path: path.join(original, "custom.sqlite") });
      const storePath = path.join(alias, "custom.json");
      const fixture = harness.configureProvider(async () => browserSession);
      const config = fixture.context.getRuntimeConfig();
      fixture.context.getRuntimeConfig = () => ({
        ...config,
        session: { store: storePath },
      });
      const ensure = voiceWriters.ensureClientVoiceAgentSessionEntry;
      let ensuring = false;
      let changed = false;
      let foreignPath: string | undefined;
      vi.spyOn(voiceWriters, "ensureClientVoiceAgentSessionEntry").mockImplementation(
        async (...args) => {
          ensuring = true;
          try {
            return await ensure(...args);
          } finally {
            ensuring = false;
          }
        },
      );
      const resolve = sqliteTarget.prepareSqliteTargetFromSessionStorePath;
      vi.spyOn(sqliteTarget, "prepareSqliteTargetFromSessionStorePath").mockImplementation(
        async (...args) => {
          const target = await resolve(...args);
          if (ensuring && !changed) {
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
      const respond = vi.fn();
      await harness.invokeCreate({
        params: { sessionKey: key, provider: "openai" },
        respond,
        context: fixture.context,
        client: fixture.client,
      } as never);
      expect(changed).toBe(true);
      expect(respond.mock.lastCall?.[0]).toBe(false);
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
      const storePath = path.join(harness.tempDir(), "sdk-cold-ensure.sqlite");
      const fixture = harness.configureProvider(async () => browserSession);
      const config = fixture.context.getRuntimeConfig();
      fixture.context.getRuntimeConfig = () => ({
        ...config,
        session: { store: storePath },
      });
      const ensure = voiceWriters.ensureClientVoiceAgentSessionEntry;
      let ensuring = false;
      let checkedBeforeCreation = false;
      vi.spyOn(voiceWriters, "ensureClientVoiceAgentSessionEntry").mockImplementation(
        async (...args) => {
          ensuring = true;
          try {
            return await ensure(...args);
          } finally {
            ensuring = false;
          }
        },
      );
      const respond = vi.fn();
      await harness.invokeCreate({
        params: { sessionKey: key, provider: "openai" },
        respond,
        context: fixture.context,
        client: fixture.client,
        sessionMutationCommitGuard: () => {
          if (ensuring) {
            checkedBeforeCreation ||= !existsSync(storePath);
            if (revoked) {
              throw new Error("SDK cold ensure authority revoked");
            }
          }
        },
      } as never);
      expect(checkedBeforeCreation).toBe(true);
      expect(respond.mock.lastCall?.[0], respond.mock.lastCall?.[2]?.message).toBe(!revoked);
      if (revoked) {
        expect(respond.mock.lastCall?.[2]?.message).toContain("SDK cold ensure authority revoked");
        expect(existsSync(storePath)).toBe(false);
        expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
      } else {
        harness.ownVoice(respond.mock.lastCall?.[1].voiceSessionId, key);
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.sessionId,
        ).toBeTruthy();
      }
    },
  );
}
