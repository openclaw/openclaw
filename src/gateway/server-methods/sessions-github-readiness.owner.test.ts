import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  assertAdmittedRunOperatorAuthority,
  createAdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { holdStateRead } from "../../state/github-publication-fixtures.test-support.js";
import { ensureGatewayOwnerProfile } from "../../state/user-profiles.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { createPresenceRecipientProjection } from "../presence-projection.js";
import * as inProcess from "../server-in-process-dispatch.js";
import { handleGatewayRequest } from "../server-methods.js";
import { gatewayProfile } from "../server/client-fixtures.test-support.js";
import { prepareSessionRowPublication } from "../session-row-presentation.js";
import { createTestProjection } from "../session-row-projection.read-fixture.test-support.js";
import {
  resolveSessionSharingRole,
  resolveSessionSharingTargetAsync,
} from "../session-sharing-policy.js";
import {
  canReceiveSessionEvent,
  createSessionListEntryFilter,
  prepareSessionSharing,
} from "../session-sharing-read.js";
import { listProjectedSessions } from "../session-utils-list.js";
import { sessionKey, type ReadFixture } from "./sessions-github-read.test-support.js";
import { bind, fixture, tool } from "./sessions-github-readiness.test-support.js";
import type { GatewayClient } from "./types.js";

afterEach(() => vi.restoreAllMocks());

async function ownerSource(f: ReadFixture) {
  const owner = ensureGatewayOwnerProfile("Shared owner");
  f.client.authenticatedUserProfile = gatewayProfile(owner.id, owner.displayName, owner.updatedAt);
  f.client.connect.client = { ...f.client.connect.client, id: "cli", mode: "cli" };
  f.client.usesSharedGatewayAuth = true;
  f.client.sharedGatewaySessionGeneration = "owner-cli-generation";
  f.client.authPolicy = captureGatewayAuthPolicy(f.context.getRuntimeConfig(), {
    role: "operator",
    authMethod: "token",
  });
  f.client.internal = { authenticatedOperator: true, operatorRoleActor: { kind: "system" } };
  const lifetime = new AbortController();
  const captured = await captureGatewayOperatorRunAuthority({
    client: f.client,
    context: f.context,
    sourceAuthority: {
      assertCurrent: () => lifetime.signal.throwIfAborted(),
      signal: lifetime.signal,
    },
  });
  assert(captured, "authenticated CLI owner must retain its admitted authority");
  return { ...captured, lifetime };
}

const ownerFixture = { scopes: ["operator.write"], others: "none", foreign: true } as const;

it("observes a human-created managed session through the CLI owner's real readiness tool", async () => {
  await fixture(
    async (f) => {
      await bind();
      const source = await ownerSource(f);
      const dispatched = vi.spyOn(inProcess, "dispatchGatewayRequestInProcessRaw");
      const caller = {
        operatorAuthority: source.authority,
        personalToolIdentityScoped: true as const,
      };
      try {
        expect(f.context.getRuntimeConfig().gateway?.roles).toBeDefined();
        expect(f.client.connect.scopes).toEqual(["operator.write"]);
        expect(source.authority.profileId).toBe(GATEWAY_OWNER_PROFILE_ID);
        expect(source.authority.scopes).toEqual(["operator.write"]);
        for (const selection of [{}, { publishingSessionKey: sessionKey }]) {
          expect(
            (await tool(f, { action: "readiness", ...selection }, caller)).details,
          ).toMatchObject({
            policy: { read: "admitted", write: "unknown" },
            custody: { kind: "qualified", source: "worktree" },
            target: { kind: "supported", basis: "registered-repository" },
          });
        }
        const readinessCalls = dispatched.mock.calls.filter(
          ([method]) => method === "sessions.github.readiness",
        );
        expect(readinessCalls.length).toBe(2);
        for (const options of readinessCalls.map((call) => call[2])) {
          expect(options.client?.connect.scopes).toEqual(["operator.read"]);
          expect(options.client?.internal?.syntheticClient).toBe(true);
          expect(options.client?.internal?.operatorRoleActor).toEqual({
            kind: "operator",
            profileId: GATEWAY_OWNER_PROFILE_ID,
          });
          const retained = options.client?.internal?.operatorRunAuthority;
          assert(retained);
          assertAdmittedRunOperatorAuthority(retained);
          retained.assertCurrent();
          expect(retained.profileId).toBe(GATEWAY_OWNER_PROFILE_ID);
          expect(retained.scopes).toEqual(["operator.read"]);
          expect(retained.source === source.authority.source).toBe(true);
        }
        const held = holdStateRead("githubPublications.sharedObservation");
        const pending = tool(f, { action: "readiness" }, caller);
        const outcome = pending.catch((error: unknown) => error);
        try {
          await awaitGateBeforeSettlement(
            held.ready,
            pending,
            "readiness ended before its receipt read",
          );
          source.lifetime.abort(new Error("owner authority revoked"));
          held.release();
          const denied = await outcome;
          expect(denied).toBeInstanceOf(Error);
          expect(denied).toMatchObject({
            message: expect.stringMatching(/authority|aborted|active/i),
          });
        } finally {
          held.release();
          await outcome;
          held.restore();
        }
      } finally {
        source.release();
      }
    },
    { ...ownerFixture, scopes: [...ownerFixture.scopes] },
  );
});

it("separates retained owner authority across interleaved list and presence audiences", async () => {
  await fixture(
    async (f) => {
      const source = await ownerSource(f);
      try {
        const cfg = f.context.getRuntimeConfig();
        using projection = await createTestProjection({ cfg, modelCatalog: [] });
        await projection.ensureMaterialized();
        const owner = (authority = source.authority): GatewayClient => ({
          connect: { ...f.client.connect, scopes: ["operator.read"] },
          internal: {
            syntheticClient: true,
            operatorRoleActor: { kind: "operator", profileId: GATEWAY_OWNER_PROFILE_ID },
            operatorRunAuthority: authority,
          },
        });
        const broad = owner();
        const equivalent = owner(createAdmittedRunOperatorAuthority({ ...source.authority }));
        const narrow = owner(
          createAdmittedRunOperatorAuthority({
            ...source.authority,
            scopes: ["operator.sessions.read"],
          }),
        );
        const person = { text: "watcher", ts: 1 };
        const presence = [{ ...person, watchedSessions: [sessionKey] }];
        const project = createPresenceRecipientProjection({ cfg, presence, projection });
        const audience = (client: GatewayClient) =>
          prepareSessionRowPublication(
            projection,
            1,
          )(client)
            .getPresentation()
            .sharing.getCacheKey();
        const list = async (client: GatewayClient) =>
          (
            await listProjectedSessions({
              projection,
              client,
              opts: { agentId: "main" },
              acceptsSerializedJson: true,
            })
          ).sessions;
        const allowedKey = audience(broad);
        const deniedKey = audience(narrow);
        expect(deniedKey).not.toBe(allowedKey);
        expect(audience(equivalent)).toBe(allowedKey);
        const rows = await list(broad);
        expect(rows.map((row) => row.key)).toEqual([sessionKey]);
        const watches = project(broad);
        expect(watches).toEqual(presence);
        for (const client of [narrow, equivalent, narrow, broad]) {
          const allowed = client !== narrow;
          expect((await list(client)).map((row) => row.key)).toEqual(allowed ? [sessionKey] : []);
          expect(project(client)).toEqual(allowed ? presence : [person]);
        }
        expect(await list(equivalent)).toBe(rows);
        expect(project(equivalent)).toBe(watches);
        // Reprepare the same client: its fast facts comparison must also retire the old key.
        broad.internal!.operatorRunAuthority = narrow.internal!.operatorRunAuthority;
        expect(audience(broad)).toBe(deniedKey);
        expect(await list(broad)).toEqual([]);
        expect(project(broad)).toEqual([person]);
        broad.internal!.operatorRunAuthority = source.authority;
        expect(audience(broad)).toBe(allowedKey);
        expect(await list(broad)).toBe(rows);
        expect(project(broad)).toBe(watches);
        const preparing = vi.spyOn(projection, "prepareSelection");
        const delivered = vi.fn();
        const pending = listProjectedSessions({
          projection,
          client: broad,
          opts: { agentId: "main" },
          acceptsSerializedJson: true,
          onResult: delivered,
        });
        // Real selection preparation yields before consulting the populated page cache.
        expect(preparing).toHaveBeenCalledOnce();
        source.lifetime.abort(new Error("owner authority revoked"));
        await expect(pending).rejects.toThrow("owner authority revoked");
        expect(delivered).not.toHaveBeenCalled();
        await expect(list(equivalent)).rejects.toThrow("owner authority revoked");
        expect(() => project(broad)).toThrow("owner authority revoked");
        expect(() => project(equivalent)).toThrow("owner authority revoked");
      } finally {
        source.release();
      }
    },
    { ...ownerFixture, scopes: [...ownerFixture.scopes] },
  );
});

it("keeps sharing role, list and event authority aligned without widening session-only writes", async () => {
  await fixture(
    async (f) => {
      const source = await ownerSource(f);
      const cfg = f.context.getRuntimeConfig();
      const target = await resolveSessionSharingTargetAsync({ cfg, sessionKey });
      assert(target?.entry.createdActor?.type === "human");
      const owner: GatewayClient = {
        connect: { ...f.client.connect, scopes: ["operator.read"] },
        internal: {
          syntheticClient: true,
          operatorRoleActor: { kind: "operator", profileId: GATEWAY_OWNER_PROFILE_ID },
          operatorRunAuthority: source.authority,
        },
      };
      const check = (client: GatewayClient) => {
        const params = { cfg, client };
        const sharing = prepareSessionSharing(params, {
          aliases: new Set(),
          sessionCap: "none",
          isMember: () => false,
        });
        const event = (name = "session.message") =>
          canReceiveSessionEvent({
            ...params,
            sessionKeys: [sessionKey],
            event: name,
            prepared: { sharing, target: () => target },
          });
        return {
          role: resolveSessionSharingRole({ ...params, target }, { value: "none" }),
          listed:
            createSessionListEntryFilter(params, undefined, { sessionCap: "none" })?.(
              sessionKey,
              target.entry,
            ) ?? true,
          event: event(),
          suggestion: event("session.suggestion"),
          typing: event("session.typing"),
        };
      };
      const allowed = {
        role: "owner",
        listed: true,
        event: true,
        suggestion: false,
        typing: false,
      };
      const denied = {
        role: "viewer",
        listed: false,
        event: false,
        suggestion: false,
        typing: false,
      };
      try {
        expect(check(owner)).toEqual(allowed);
        expect(check({ ...owner, internal: { operatorRoleActor: { kind: "system" } } })).toEqual(
          allowed,
        );
        expect(check({ ...owner, internal: { syntheticClient: true } })).toEqual(denied);
        expect(
          check({ ...owner, internal: { ...owner.internal, operatorRunAuthority: undefined } }),
        ).toEqual(denied);
        expect(
          check({ ...owner, connect: { ...owner.connect, scopes: ["operator.sessions.read"] } }),
        ).toEqual(denied);
        const narrow = createAdmittedRunOperatorAuthority({
          ...source.authority,
          scopes: ["operator.sessions.read"],
        });
        expect(
          check({ ...owner, internal: { ...owner.internal, operatorRunAuthority: narrow } }),
        ).toEqual(denied);
        const person = gatewayProfile("other-person", "Other person");
        expect(check({ ...owner, authenticatedUserProfile: person })).toEqual(denied);
        for (const invalid of [
          { ...source.authority },
          createAdmittedRunOperatorAuthority({ ...source.authority, profileId: "other-person" }),
        ]) {
          expect(() =>
            check({ ...owner, internal: { ...owner.internal, operatorRunAuthority: invalid } }),
          ).toThrow(/host|profile/);
        }
        expect(() =>
          check({
            ...owner,
            internal: {
              ...owner.internal,
              operatorRoleActor: { kind: "operator", profileId: "other-person" },
            },
          }),
        ).toThrow(/profile/);
        const respond = vi.fn();
        await handleGatewayRequest({
          client: {
            ...owner,
            connect: { ...owner.connect, scopes: ["operator.read", "operator.sessions.write"] },
          },
          context: f.context,
          req: {
            type: "req",
            id: "narrow-owner-write",
            method: "sessions.patch",
            params: { key: sessionKey, label: "must not write" },
          },
          isWebchatConnect: () => false,
          respond,
        });
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "FORBIDDEN",
            message: "Session-scoped writes require your own session.",
          }),
        );
        expect(
          (await resolveSessionSharingTargetAsync({ cfg, sessionKey }))?.entry.label,
        ).toBeUndefined();
        source.lifetime.abort(new Error("owner authority revoked"));
        expect(() => check(owner)).toThrow("owner authority revoked");
      } finally {
        source.release();
      }
    },
    { ...ownerFixture, scopes: [...ownerFixture.scopes] },
  );
});
