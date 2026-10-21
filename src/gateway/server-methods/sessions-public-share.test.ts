import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import {
  SessionPublicShareSetResultSchema,
  SessionMembersListEvidenceResultSchema,
} from "../../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  assignSessionOwner,
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import * as sharingStore from "../../config/sessions/session-sharing-store.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import * as sharingLifecycle from "../../sessions/session-controller.lifecycle.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { isPublicSessionShareActive } from "../control-ui-public-session-read.js";
import * as publicSessionTokens from "../control-ui-public-session-token.js";
import { createTestProjection } from "../session-row-projection.read-fixture.test-support.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import { identifiedClient, sessionSharingTestContext } from "./sessions-sharing.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

afterEach(async () => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
});

const cfg = {};
const scope = { agentId: "main", sessionKey: "agent:main:public-example" };
const sessionId = "public-example-generation";
const ownerEntry = {
  sessionId,
  updatedAt: 1,
  createdActor: { type: "human", source: "profile", id: "owner" },
} as const;
const grant = () =>
  expectDefined(loadSessionEntry(scope)?.publicShare, "persisted public share grant");
const resolveToken = (share: { token: string } | undefined) =>
  publicSessionTokens.resolvePublicSessionShareToken(share?.token ?? "");

async function call(
  method: "session.publicShare.set" | "session.members.listEvidence" | "session.visibility.set",
  params: Record<string, unknown> = scope,
  client: GatewayClient = identifiedClient("owner"),
  preparedContext?: GatewayRequestContext,
  respond = vi.fn<RespondFn>(),
) {
  const context = preparedContext ?? sessionSharingTestContext(vi.fn(), cfg);
  if (!preparedContext) {
    await initializeSessionReadContext(context);
  }
  const handler = expectDefined(sessionSharingHandlers[method], "sharing handler");
  await handler({ params, client, context, respond } as never);
  return respond.mock.calls[0];
}

function beforeWrite(change: () => unknown) {
  const run = sharingLifecycle.runSessionMutation;
  vi.spyOn(sharingLifecycle, "runSessionMutation").mockImplementationOnce(async (params) => {
    await change();
    return run(params);
  });
}

async function expectToken(share: { token: string } | undefined, shareId: string) {
  expect(await resolveToken(share)).toEqual({ ...scope, sessionId, shareId });
}

const publication = (result: Awaited<ReturnType<typeof call>>) =>
  Value.Decode(SessionPublicShareSetResultSchema, result?.[1]).publicShare;

const expectStale = (pending: Promise<unknown>) =>
  expect(pending).rejects.toThrow("Session access facts are unavailable");

function withSession(run: () => Promise<void>, sessionScope = scope) {
  return withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(cfg);
    await upsertSessionEntryCore(sessionScope, ownerEntry);
    await run();
  });
}

async function setPublic(enabled: boolean, client?: GatewayClient, expectedSessionId = sessionId) {
  return call("session.publicShare.set", { ...scope, expectedSessionId, enabled }, client);
}

it("keeps explicit publication with the causal creator through a cold reopen", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(cfg);
    await upsertSessionEntryCore(scope, {
      ...ownerEntry,
      createdActor: {
        type: "human",
        source: "profile",
        id: "isolation-owner",
        delegatedBy: ownerEntry.createdActor,
      },
    });
    assignSessionOwner(scope, {
      owner: { type: "human", id: "assignee" },
      assignedBy: ownerEntry.createdActor,
    });
    expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
    for (const id of ["isolation-owner", "assignee"]) {
      expect((await setPublic(true, identifiedClient(id)))?.[0]).toBe(false);
    }
    const published = publication(await setPublic(true));
    const saved = grant();
    await closeOpenClawAgentDatabasesAsync();
    await expectToken(published, saved.id);
    const locator = expectDefined(await resolveToken(published), "published locator");
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    expect(isPublicSessionShareActive(cfg, locator, projection)).toBe(true);
    const retained = loadSessionEntry(scope)!;
    expect(retained.createdActor?.id).toBe("isolation-owner");
    expect(projectPublicSessionEntry(retained).createdActor).toEqual(ownerEntry.createdActor);
    expect((await setPublic(false))?.[0]).toBe(true);
    await projection.ensureMaterialized();
    expect(isPublicSessionShareActive(cfg, locator, projection)).toBe(false);
    expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
  }));

it("publishes, reuses, revokes and rotates links independently of team visibility", () =>
  withSession(async () => {
    const published = await setPublic(true);
    expect(published?.[0]).toBe(true);
    const result = publication(published);
    const firstGrant = grant();
    expect(result).toEqual({
      token: expect.stringMatching(/^v1\.[A-Za-z0-9_-]+$/u),
      createdAt: firstGrant.createdAt,
    });
    await expectToken(result, firstGrant.id);
    expect(isSecretValueRegisteredForRedaction(result?.token ?? "")).toBe(true);
    expect(isSecretValueRegisteredForRedaction(firstGrant.id)).toBe(true);
    expect(loadSessionEntry(scope)?.visibility).toBeUndefined();

    const repeated = publication(await setPublic(true));
    expect(repeated?.token).not.toBe(result?.token);
    expect(repeated?.createdAt).toBe(result?.createdAt);
    const listed = await call("session.members.listEvidence", scope);
    const listedShare = Value.Decode(
      SessionMembersListEvidenceResultSchema,
      listed?.[1],
    ).publicShare;
    expect(listedShare?.createdAt).toBe(result?.createdAt);
    await expectToken(listedShare, firstGrant.id);
    expect(projectPublicSessionEntry(loadSessionEntry(scope)!)).not.toHaveProperty("publicShare");

    expect((await setPublic(false))?.[0]).toBe(true);
    expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
    const republished = publication(await setPublic(true));
    const republishedGrant = grant();
    expect(republishedGrant.id).not.toBe(firstGrant.id);
    expect((await resolveToken(republished))?.shareId).toBe(republishedGrant.id);
  }));

it("rejects non-managers and stale generations without changing publication", () =>
  withSession(async () => {
    expect((await setPublic(true, identifiedClient("outsider")))?.[0]).toBe(false);
    expect((await setPublic(true, undefined, "previous-generation"))?.[0]).toBe(false);
    expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
    const admin = identifiedClient("admin");
    admin.connect.scopes = ["operator.admin"];
    expect((await setPublic(true, admin))?.[0]).toBe(true);
    const existingGrant = loadSessionEntry(scope)?.publicShare;
    expect((await setPublic(false, identifiedClient("outsider")))?.[0]).toBe(false);
    expect(loadSessionEntry(scope)?.publicShare).toEqual(existingGrant);
  }));

it("rejects publication when runtime config remaps the exact store before commit", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "global";
    const firstStorePath = state.path("public-share-first.sqlite");
    const secondStorePath = state.path("public-share-second.sqlite");
    const configFor = (store: string) => ({
      session: { scope: "global" as const, store },
      agents: {
        ownership: "explicit" as const,
        defaults: { sessionStore: { agentId: "main" } },
        entries: { main: {} },
      },
    });
    const firstConfig = configFor(firstStorePath);
    const secondConfig = configFor(secondStorePath);
    setRuntimeConfigSnapshot(firstConfig);
    for (const storePath of [firstStorePath, secondStorePath]) {
      await upsertSessionEntryCore({ agentId: "main", sessionKey, storePath }, ownerEntry);
    }
    let currentConfig = firstConfig;
    const requestContext = sessionSharingTestContext(vi.fn(), firstConfig);
    requestContext.getRuntimeConfig = () => currentConfig;
    await initializeSessionReadContext(requestContext);
    beforeWrite(() => {
      currentConfig = secondConfig;
    });
    const admin = identifiedClient("admin");
    admin.connect.scopes = ["operator.admin"];
    const respond = vi.fn<RespondFn>();

    await expectStale(
      call(
        "session.publicShare.set",
        { sessionKey, expectedSessionId: sessionId, enabled: true },
        admin,
        requestContext,
        respond,
      ),
    );

    expect(respond).not.toHaveBeenCalled();
    for (const storePath of [firstStorePath, secondStorePath]) {
      expect(
        loadSessionEntry({ agentId: "main", sessionKey, storePath })?.publicShare,
      ).toBeUndefined();
    }
  }));

it.each([
  ["session.publicShare.set", true],
  ["session.members.listEvidence", true],
  ["session.visibility.set", true],
  ["session.visibility.set", false],
] as const)("%s uses the fresh stored row (generation replaced: %s)", (method, resetGeneration) =>
  withSession(async () => {
    await closeOpenClawAgentDatabasesAsync();
    expect((await call("session.visibility.set", { ...scope, visibility: "shared" }))?.[0]).toBe(
      true,
    );
    expect(loadSessionEntry(scope)?.createdActor?.id).toBe("owner");
    if (!resetGeneration) {
      expect(loadSessionEntry(scope)?.visibility).toBeUndefined();
    }
    const resetSession = () =>
      upsertSessionEntryCore(
        scope,
        resetGeneration ? { sessionId: "replacement-generation" } : { visibility: "draft" },
      );
    if (method !== "session.members.listEvidence") {
      beforeWrite(resetSession);
    } else {
      const read = sharingStore.readSessionMembersInWorker;
      vi.spyOn(sharingStore, "readSessionMembersInWorker").mockImplementationOnce(async (input) => {
        const evidence = await read(input);
        await resetSession();
        return evidence;
      });
    }
    const pending =
      method === "session.publicShare.set"
        ? setPublic(true)
        : call(method, {
            ...scope,
            ...(method === "session.visibility.set" ? { visibility: "shared" } : {}),
          });
    if (resetGeneration) {
      await expectStale(pending);
      const entry = loadSessionEntry(scope);
      expect(entry).toMatchObject({
        sessionId: "replacement-generation",
        createdActor: { id: "owner" },
      });
      expect(entry?.publicShare).toBeUndefined();
    } else {
      expect((await pending)?.[0]).toBe(true);
      expect(loadSessionEntry(scope)?.visibility).toBe("shared");
    }
  }),
);

it.each([false, true])(
  "rechecks a worker-committed generation change during codec preparation (restored grant: %s)",
  (restoredGrant) =>
    withSession(async () => {
      await setPublic(true);
      const publishedGrant = grant();
      if (restoredGrant) {
        await setPublic(false);
        const read = sharingStore.readSessionMembersInWorker;
        vi.spyOn(sharingStore, "readSessionMembersInWorker").mockImplementationOnce(
          async (input) => {
            await upsertSessionEntryCore(scope, { publicShare: publishedGrant });
            return read(input);
          },
        );
      }
      const loadCodec = publicSessionTokens.loadPublicSessionShareTokenCodec;
      vi.spyOn(publicSessionTokens, "loadPublicSessionShareTokenCodec").mockImplementationOnce(
        async (options) => {
          const codec = await loadCodec(options);
          await upsertSessionEntryCore(scope, {
            sessionId: "replacement-generation",
          });
          return codec;
        },
      );
      await expectStale(call("session.members.listEvidence", scope));
      expect(loadSessionEntry(scope)?.sessionId).toBe("replacement-generation");
    }),
);

const oversizedScope = { ...scope, sessionKey: `agent:main:${"🙂".repeat(2_000)}` };
it("rejects an unencodable locator before persisting its publication grant", () =>
  withSession(async () => {
    await expect(
      call("session.publicShare.set", {
        ...oversizedScope,
        expectedSessionId: sessionId,
        enabled: true,
      }),
    ).rejects.toThrow("public session locator exceeds the maximum length");
    expect(loadSessionEntry(oversizedScope)?.publicShare).toBeUndefined();
  }, oversizedScope));

it("drops publication at the canonical writer on reset, fork and incognito", () =>
  withSession(async () => {
    await setPublic(true);
    const original = loadSessionEntry(scope)!;
    const forkScope = { ...scope, sessionKey: "agent:main:public-example-fork" };
    await upsertSessionEntryCore(forkScope, { ...original, sessionId: "fork-generation" });
    expect(loadSessionEntry(forkScope)?.publicShare).toBeUndefined();
    expect(loadSessionEntry(scope)?.publicShare).toEqual(original.publicShare);
    await patchSessionEntryCore(scope, () => ({ sessionId: "reset-generation" }));
    expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
    expect((await setPublic(true))?.[0]).toBe(false);
    expect((await setPublic(true, undefined, "reset-generation"))?.[0]).toBe(true);
    await patchSessionEntryCore(scope, () => ({ incognito: true }));
    expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
    await patchSessionEntryCore(scope, () => ({ incognito: undefined }));
    expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
  }));
