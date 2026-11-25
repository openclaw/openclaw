import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { withCurrentSessionListRows } from "./session-list-read-result.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import {
  createTestProjection,
  seedRow,
} from "./session-row-projection.read-fixture.test-support.js";
import * as sharingRead from "./session-sharing-read.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());

it.each(["profile", "actor"] as const)(
  "uses current invited membership for %s inventory, linked children, and buffered enrichment",
  async (principal) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = rolePolicyConfig();
      const owner = ensureProfileForEmail("owner@inventory.test");
      const member = ensureProfileForEmail("member@inventory.test");
      const unrelated = ensureProfileForEmail("unrelated@inventory.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const clients = [owner, member, unrelated].map((profile) => {
        const client = sharingPolicyClient({ user: profile.id });
        prepareGatewayRecipientProfile(client);
        if (principal === "actor") {
          client.internal = { operatorRoleActor: { kind: "operator", profileId: profile.id } };
          delete client.authenticatedUserProfile;
          delete client.authenticatedUserId;
        }
        return client;
      });
      const original = sharingRead.prepareProjectedSessionSharing;
      // Activation is step 13. Only the prepared cap is supplied here; membership,
      // selection, linked-row presentation, and final enrichment remain production paths.
      vi.spyOn(sharingRead, "prepareProjectedSessionSharing").mockImplementation((params) => ({
        ...original(params),
        ...sharingRead.prepareSessionSharing(params, {
          aliases: new Set([
            params.client?.authenticatedUserProfile?.profileId ??
              (params.client?.internal?.operatorRoleActor?.kind === "operator"
                ? params.client.internal.operatorRoleActor.profileId
                : ""),
          ]),
          sessionCap: "invited",
          isMember: params.isMember,
        }),
      }));
      const parent = "agent:main:dashboard:inventory-parent";
      const child = "agent:main:dashboard:inventory-child";
      const hidden = "agent:main:dashboard:inventory-hidden";
      for (const key of [parent, child, hidden]) {
        seedRow(key, {
          sessionId: key,
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: owner.id },
          ...(key === parent ? {} : { parentSessionKey: parent }),
        });
      }
      const runs = [child, hidden].map((key, index) => {
        const run = createSubagentRunRecord({
          runId: `invited-collector-${index}`,
          childSessionKey: key,
          childSessionIdentity: { sessionId: key },
          requesterAgentId: "main",
          requesterSessionKey: parent,
          swarmRequesterSessionKey: parent,
          collect: true,
          groupId: "invited-collector",
          createdAt: index + 1,
          endedAt: 3,
          collectorCompletion: { status: "done" },
          expectsCompletionMessage: false,
        });
        subagentRuns.set(run.runId, run);
        return run;
      });
      onTestFinished(() => runs.forEach((run) => subagentRuns.delete(run.runId)));
      const scope = (sessionKey: string) => ({ agentId: "main", sessionKey });
      for (const key of [parent, child]) {
        addSessionMember(scope(key), { identityId: member.id, addedBy: owner.id });
      }
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      const list = (client = clients[1]!) =>
        listProjectedSessions({ projection, client, opts: {} });
      const admitted = await list();
      expect(admitted.sessions.map((row) => row.key).toSorted()).toEqual([child, parent]);
      const parentRow = admitted.sessions.find((row) => row.key === parent)!;
      expect(parentRow.childSessions).toEqual([child]);
      expect(parentRow.swarm?.groups[0]?.children?.map((row) => row.sessionKey)).toEqual([child]);
      expect((await list(clients[2]!)).sessions).toEqual([]);
      expect((await list(clients[0]!)).sessions.map((row) => row.key).toSorted()).toEqual([
        child,
        hidden,
        parent,
      ]);
      removeSessionMember(scope(child), member.id);
      const revokedChild = await list();
      expect(revokedChild.sessions.map((row) => row.key)).toEqual([parent]);
      expect(revokedChild.sessions[0]?.childSessions).toBeUndefined();
      expect(revokedChild.sessions[0]?.swarm?.groups[0]?.children).toEqual([]);
      expect(
        await withCurrentSessionListRows(admitted.sessions, (visible) => visible, true),
      ).toEqual(admitted.sessions.map((row) => row.key === parent));
      const prepare = projection.withPreparedExactRows.bind(projection);
      let revoke = true;
      vi.spyOn(projection, "withPreparedExactRows").mockImplementation(
        (queries, consume, options) =>
          prepare(
            (config) => {
              const selected = queries(config);
              if (revoke) {
                revoke = false;
                removeSessionMember(scope(parent), member.id);
              }
              return selected;
            },
            consume,
            options,
          ),
      );
      // Revoke after initial selection, before asynchronous row preparation completes.
      expect((await list()).sessions).toEqual([]);
      expect(
        await withCurrentSessionListRows(admitted.sessions, (visible) => visible, true),
      ).toEqual(admitted.sessions.map(() => false));
    });
  },
);

it("authorizes linked children from the physical lineage store, not a duplicate key", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const cfg = rolePolicyConfig();
      const owner = ensureProfileForEmail("owner@federated-inventory.test");
      const member = ensureProfileForEmail("member@federated-inventory.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const client = sharingPolicyClient({ user: member.id });
      prepareGatewayRecipientProfile(client);
      const original = sharingRead.prepareProjectedSessionSharing;
      vi.spyOn(sharingRead, "prepareProjectedSessionSharing").mockImplementation((params) => ({
        ...original(params),
        ...sharingRead.prepareSessionSharing(params, {
          aliases: new Set([member.id]),
          sessionCap: "invited",
          isMember: params.isMember,
        }),
      }));
      const parent = "agent:main:dashboard:federated-parent";
      const child = "global";
      const mainPath = resolveSessionStorePathCore(undefined, { agentId: "main" });
      const workPath = state.statePath("secondary.sqlite");
      const entry = (sessionId: string) => ({
        sessionId,
        updatedAt: Date.now(),
        visibility: "shared" as const,
        createdActor: { type: "human" as const, source: "profile" as const, id: owner.id },
      });
      seedRow({ agentId: "main", key: child, storePath: mainPath }, entry("duplicate"));
      seedRow({ agentId: "main", key: parent, storePath: workPath }, entry("parent"));
      seedRow(
        { agentId: "main", key: child, storePath: workPath },
        { ...entry("linked"), parentSessionKey: parent },
      );
      registerOpenClawAgentDatabase({ agentId: "main", path: workPath });
      for (const [sessionKey, storePath] of [
        [parent, workPath],
        [child, mainPath],
      ] as const) {
        addSessionMember(
          { agentId: "main", sessionKey, storePath },
          { identityId: member.id, addedBy: owner.id },
        );
      }
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      const list = async () => {
        await projection.ensureMaterialized();
        await projection.prepareMembership();
        return prepareProjectedSessionPresentation(projection, client).snapshot({
          agentId: "main",
          key: parent,
          storePath: workPath,
        }).row;
      };
      expect((await list())?.childSessions).toBeUndefined();
      addSessionMember(
        { agentId: "main", sessionKey: child, storePath: workPath },
        { identityId: member.id, addedBy: owner.id },
      );
      expect((await list())?.childSessions).toEqual([child]);
      removeSessionMember({ agentId: "main", sessionKey: child, storePath: mainPath }, member.id);
      expect((await list())?.childSessions).toEqual([child]);
    },
  );
});
