import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { assignSessionOwner, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { attributeDelegatedSessionCreator } from "../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { linkEmail } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import {
  createSessionListEntryFilter,
  resolveSessionSharingRole,
  resolveSessionSharingTargetAsync,
} from "./session-sharing.js";
import { canReceivePreparedSessionEvent } from "./session-sharing.test-utils.js";

const readerConfig = (): OpenClawConfig => ({
  gateway: {
    roles: {
      default: "reader",
      definitions: {
        reader: {
          sessions: { others: "none" },
          agents: "*",
          scopes: ["operator.read", "operator.write"],
        },
      },
    },
  },
});
const profileClient = (profileId: string) =>
  ({
    connect: { scopes: ["operator.read", "operator.write"] },
    authenticatedUserProfile: { profileId },
  }) as GatewayClient;
const receive = (cfg: OpenClawConfig, client: GatewayClient, sessionKey: string) =>
  canReceivePreparedSessionEvent({ cfg, client: client as never, sessionKeys: [sessionKey] });
const withProfiles = (run: () => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, run);
const sharingTarget = async (cfg: OpenClawConfig, sessionKey: string) =>
  expectDefined(await resolveSessionSharingTargetAsync({ cfg, sessionKey }), "persisted session");

describe("creator namespace authorization", () => {
  it("never turns matching attribution or responsibility into a profile creator grant", async () => {
    await withProfiles(async () => {
      const profile = ensureProfileForEmail("creator@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const client = profileClient(profile.id);
      const cfg = readerConfig();
      setRuntimeConfigSnapshot(cfg);
      const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
      const actors = [
        { type: "human", source: "profile" },
        { type: "human", source: "channel" },
        { type: "human", source: "unknown" },
        { type: "agent" },
        { type: "system" },
      ] as const;
      for (const actor of actors) {
        const sessionKey = `agent:main:creator-${actor.type}-${"source" in actor ? actor.source : "native"}`;
        const entry = {
          sessionId: sessionKey,
          updatedAt: 1,
          createdVia: "cron" as const,
          createdActor: { ...actor, id: profile.id },
          visibility: "draft" as const,
        };
        await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
        assignSessionOwner(
          { agentId: "main", sessionKey },
          {
            owner: { type: "human", id: profile.id },
            assignedBy: { type: "human", id: profile.id },
          },
        );
        const target = await sharingTarget(cfg, sessionKey);
        const isCreator = actor.type === "human" && actor.source === "profile";
        const check = (value: unknown) => expect.soft(value, sessionKey);
        check(resolveSessionSharingRole({ cfg, client, target, isMember: false })).toBe(
          isCreator ? "owner" : "viewer",
        );
        check(createSessionListEntryFilter({ cfg, client })?.(sessionKey, target.entry)).toBe(
          isCreator,
        );
        check(await receive(cfg, client, sessionKey)).toBe(isCreator);
        for (const method of ["sessions.get", "sessions.patch"]) {
          const result = await resolveSessionMutationAuthorizationAsync({
            client,
            method,
            requestParams: { key: sessionKey },
            context,
          });
          expect.soft(result.error === null, `${sessionKey}: ${method}`).toBe(isCreator);
        }
      }
    });
  });

  it.each([true, false])(
    "uses delegated attribution for discovery and creator rights, not the legacy actor or assignee (human: %s)",
    async (hasHuman) => {
      await withProfiles(async () => {
        const profiles = ["causal", "isolation", "assignee"].map((name) =>
          ensureProfileForEmail(name + "@example.test"),
        );
        const [causal, isolation, assignee] = profiles;
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        const cfg = readerConfig();
        setRuntimeConfigSnapshot(cfg);
        const sessionKey = "agent:main:delegated-creator";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "delegated-creator",
            updatedAt: 1,
            createdVia: "spawn",
            visibility: "draft",
            createdActor: attributeDelegatedSessionCreator(
              { type: "human", source: "profile", id: isolation!.id },
              hasHuman ? causal!.id : undefined,
              "main",
            ),
          },
        );
        assignSessionOwner(
          { agentId: "main", sessionKey },
          {
            owner: { type: "human", id: assignee!.id },
            assignedBy: { type: "human", id: causal!.id },
          },
        );
        const target = await sharingTarget(cfg, sessionKey);
        for (const profile of profiles) {
          const client = profileClient(profile.id);
          const expectedCreator = hasHuman && profile.id === causal!.id;
          expect(resolveSessionSharingRole({ cfg, client, target, isMember: false })).toBe(
            expectedCreator ? "owner" : "viewer",
          );
          expect(createSessionListEntryFilter({ cfg, client })?.(sessionKey, target.entry)).toBe(
            expectedCreator,
          );
          expect(await receive(cfg, client, sessionKey)).toBe(expectedCreator);
        }
        expect(target.entry.createdActor?.id).toBe(isolation!.id);
      });
    },
  );

  it("resolves profile tombstones after warming event snapshots without rewriting creators", async () => {
    await withProfiles(async () => {
      setRuntimeConfigSnapshot({});
      const old = ensureProfileForEmail("old@example.test");
      const current = ensureProfileForEmail("current@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const client = {
        connect: { scopes: ["operator.read"] },
        authenticatedUserProfile: { profileId: current.id },
      } as GatewayClient;
      const sessionKey = "agent:main:merged-creator";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "merged-creator",
          updatedAt: 1,
          visibility: "draft",
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: old.id },
        },
      );
      expect(await receive({}, client, sessionKey)).toBe(false);
      linkEmail("old@example.test", current.id);
      expect(await receive({}, client, sessionKey)).toBe(true);
      const target = await sharingTarget({}, sessionKey);
      expect(target.entry.createdActor?.id).toBe(old.id);
      expect(resolveSessionSharingRole({ client, target, isMember: false })).toBe("owner");
      expect(createSessionListEntryFilter({ client })?.(sessionKey, target.entry)).toBe(true);
    });
  });
});
