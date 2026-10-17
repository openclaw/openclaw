import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import {
  SessionPublicShareSetResultSchema,
  SessionMembersListEvidenceResultSchema,
} from "../../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import * as sharingStore from "../../config/sessions/session-sharing-store.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import * as sharingLifecycle from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as publicSessionTokens from "../control-ui-public-session-token.js";
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

function beforeWrite(change: () => Promise<unknown>) {
  const run = sharingLifecycle.runExclusiveSessionLifecycleMutation;
  vi.spyOn(sharingLifecycle, "runExclusiveSessionLifecycleMutation").mockImplementationOnce(
    async (operation, params) => {
      await change();
      return run(operation, params);
    },
  );
}

async function expectToken(share: { token: string } | undefined, shareId: string) {
  expect(await resolveToken(share)).toEqual({ ...scope, sessionId, shareId });
}

async function createSession() {
  setRuntimeConfigSnapshot(cfg);
  await upsertSessionEntryCore(scope, ownerEntry);
}

async function setPublic(enabled: boolean, client?: GatewayClient, expectedSessionId = sessionId) {
  return call("session.publicShare.set", { ...scope, expectedSessionId, enabled }, client);
}

async function setShared() {
  expect((await call("session.visibility.set", { ...scope, visibility: "shared" }))?.[0]).toBe(
    true,
  );
}

it("lets the owner publish, reuse, revoke and rotate a public link independently of team visibility", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await createSession();
    const published = await setPublic(true);
    expect(published?.[0]).toBe(true);
    const result = Value.Decode(SessionPublicShareSetResultSchema, published?.[1]);
    const firstGrant = grant();
    expect(result.publicShare).toEqual({
      token: expect.stringMatching(/^v1\.[A-Za-z0-9_-]+$/u),
      createdAt: firstGrant.createdAt,
    });
    await expectToken(result.publicShare, firstGrant.id);
    expect(isSecretValueRegisteredForRedaction(result.publicShare?.token ?? "")).toBe(true);
    expect(isSecretValueRegisteredForRedaction(firstGrant.id)).toBe(true);
    expect(loadSessionEntry(scope)?.visibility).toBeUndefined();

    const repeated = await setPublic(true);
    const repeatedResult = Value.Decode(SessionPublicShareSetResultSchema, repeated?.[1]);
    expect(repeatedResult.publicShare?.token).not.toBe(result.publicShare?.token);
    expect(repeatedResult.publicShare?.createdAt).toBe(result.publicShare?.createdAt);
    const listed = await call("session.members.listEvidence", scope);
    const listedShare = Value.Decode(
      SessionMembersListEvidenceResultSchema,
      listed?.[1],
    ).publicShare;
    expect(listedShare?.createdAt).toBe(result.publicShare?.createdAt);
    await expectToken(listedShare, firstGrant.id);
    expect(projectPublicSessionEntry(loadSessionEntry(scope)!)).not.toHaveProperty("publicShare");

    expect((await setPublic(false))?.[0]).toBe(true);
    expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
    const firstGrantId = firstGrant.id;
    const republished = Value.Decode(
      SessionPublicShareSetResultSchema,
      (await setPublic(true))?.[1],
    );
    const republishedGrant = grant();
    expect(republishedGrant.id).not.toBe(firstGrantId);
    expect((await resolveToken(republished.publicShare))?.shareId).toBe(republishedGrant.id);
  });
});

it("rejects non-managers and stale generation confirmations without changing publication", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await createSession();
    expect((await setPublic(true, identifiedClient("outsider")))?.[0]).toBe(false);
    expect((await setPublic(true, undefined, "previous-generation"))?.[0]).toBe(false);
    expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
    const admin = identifiedClient("admin");
    admin.connect.scopes = ["operator.admin"];
    expect((await setPublic(true, admin))?.[0]).toBe(true);
    const publication = loadSessionEntry(scope)?.publicShare;
    expect((await setPublic(false, identifiedClient("outsider")))?.[0]).toBe(false);
    expect(loadSessionEntry(scope)?.publicShare).toEqual(publication);
  });
});

it("rejects publication when runtime config remaps the exact store before commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
    const run = sharingLifecycle.runExclusiveSessionLifecycleMutation;
    vi.spyOn(sharingLifecycle, "runExclusiveSessionLifecycleMutation").mockImplementationOnce(
      async (operation, params) => {
        currentConfig = secondConfig;
        return run(operation, params);
      },
    );
    const admin = identifiedClient("admin");
    admin.connect.scopes = ["operator.admin"];
    const respond = vi.fn<RespondFn>();

    await expect(
      call(
        "session.publicShare.set",
        { sessionKey, expectedSessionId: sessionId, enabled: true },
        admin,
        requestContext,
        respond,
      ),
    ).rejects.toThrow("Session access facts are unavailable");

    expect(respond).not.toHaveBeenCalled();
    for (const storePath of [firstStorePath, secondStorePath]) {
      expect(
        loadSessionEntry({ agentId: "main", sessionKey, storePath })?.publicShare,
      ).toBeUndefined();
    }
  });
});

it.each([
  ["session.publicShare.set", true],
  ["session.members.listEvidence", true],
  ["session.visibility.set", true],
  ["session.visibility.set", false],
] as const)(
  "%s uses the fresh stored row (generation replaced: %s)",
  async (method, resetGeneration) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await createSession();
      await closeOpenClawAgentDatabasesAsync();
      await setShared();
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
        vi.spyOn(sharingStore, "readSessionMembersInWorker").mockImplementationOnce(
          async (input) => {
            const evidence = await read(input);
            await resetSession();
            return evidence;
          },
        );
      }
      const pending =
        method === "session.publicShare.set"
          ? setPublic(true)
          : call(method, {
              ...scope,
              ...(method === "session.visibility.set" ? { visibility: "shared" } : {}),
            });
      if (resetGeneration) {
        await expect(pending).rejects.toThrow("Session access facts are unavailable");
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
    });
  },
);

it.each([false, true])(
  "rechecks a worker-committed generation change during codec preparation (restored grant: %s)",
  async (restoredGrant) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await createSession();
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
      await expect(call("session.members.listEvidence", scope)).rejects.toThrow(
        "Session access facts are unavailable",
      );
      expect(loadSessionEntry(scope)?.sessionId).toBe("replacement-generation");
    });
  },
);

it("rejects an unencodable locator before persisting its publication grant", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(cfg);
    const oversizedScope = {
      agentId: "main",
      sessionKey: `agent:main:${"🙂".repeat(2_000)}`,
    };
    await upsertSessionEntryCore(oversizedScope, ownerEntry);

    await expect(
      call("session.publicShare.set", {
        ...oversizedScope,
        expectedSessionId: sessionId,
        enabled: true,
      }),
    ).rejects.toThrow("public session locator exceeds the maximum length");
    expect(loadSessionEntry(oversizedScope)?.publicShare).toBeUndefined();
  });
});

it("drops publication at the canonical writer when resetting or copying into a fork", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await createSession();
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
  });
});
