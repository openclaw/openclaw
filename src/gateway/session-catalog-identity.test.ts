import { afterEach, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { linkEmail, syncGitHubIdentity } from "../state/user-profile-writes.worker.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createSessionCatalogGitHubLinker,
  prepareSessionCatalogGitHubLinker,
  prepareSessionCatalogSourceActorProjector,
  prepareSessionCatalogSourceParticipantProjector,
} from "./session-catalog-identity.js";

afterEach(() => vi.restoreAllMocks());

it("links every verified account to one person while exporting only the primary account", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const remote = {
      identity: {
        type: "remote",
        pluginId: "fixture",
        domain: "fixture",
        idKind: "profile",
        id: "remote",
      },
    } as const;
    const unlinked = await prepareSessionCatalogGitHubLinker({ participants: [remote] });
    expect(unlinked.linkParticipant(remote)).toBe(remote);
    expect(unlinked.resolveOwner("profile:missing")).toBeUndefined();
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    const primary = syncGitHubIdentity({
      identity: { accountId: 101, login: "primary", name: "One Person" },
      authenticationAlias: { kind: "email", email: "primary@example.test" },
    });
    const secondary = syncGitHubIdentity({
      identity: { accountId: 102, login: "secondary" },
      authenticationAlias: { kind: "email", email: "secondary@example.test" },
    });
    linkEmail("secondary@example.test", primary.id);
    const linker = createSessionCatalogGitHubLinker();
    for (const id of ["101", "102"]) {
      expect(
        linker.linkParticipant({
          identity: {
            type: "remote",
            pluginId: "fixture",
            domain: "fixture",
            idKind: "github-account",
            id,
          },
        }).identity,
      ).toEqual({ type: "profile", id: primary.id });
    }
    expect(linker.resolveOwner("github:secondary")?.id).toBe(primary.id);
    const database = openOpenClawStateDatabase();
    const prepare = database.db.prepare.bind(database.db);
    const hostSql = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
      if (/user_profiles|user_profile_identities/.test(sql)) {
        throw new Error("Profile catalog projection executed SQL on the host");
      }
      return prepare(sql);
    });
    const actor = { type: "human", source: "profile", id: secondary.id } as const;
    const source = { pluginId: "fixture", sourceDomain: "fixture", actors: [actor] };
    const portable = await prepareSessionCatalogSourceActorProjector(source);
    expect(portable(actor)?.identity).toMatchObject({ idKind: "github-account", id: "101" });
    const senderIdentity = { type: "profile", id: secondary.id } as const;
    const sender = await prepareSessionCatalogSourceParticipantProjector([senderIdentity]);
    expect(
      sender.project({
        pluginId: "fixture",
        sourceDomain: "fixture",
        identity: senderIdentity,
      }).identity,
    ).toMatchObject({ idKind: "github-account", id: "101" });
    const participants = ["101", "102"].map((id) => ({
      identity: {
        type: "remote",
        pluginId: "fixture",
        domain: "fixture",
        idKind: "github-account",
        id,
      } as const,
    }));
    const prepared = await prepareSessionCatalogGitHubLinker({
      participants,
      owners: ["github:SECONDARY", "profile:missing"],
    });
    expect(
      participants.map((participant) => prepared.linkParticipant(participant).identity),
    ).toEqual([
      { type: "profile", id: primary.id },
      { type: "profile", id: primary.id },
    ]);
    expect(prepared.resolveOwner("github:SECONDARY")?.id).toBe(primary.id);
    expect(prepared.resolveOwner("profile:missing")).toBeUndefined();
    hostSql.mockRestore();

    const foreign = openNodeSqliteDatabase(database.path);
    try {
      foreign
        .prepare("UPDATE user_profiles SET display_name = ? WHERE id = ?")
        .run("Changed Person", primary.id);
      foreign
        .prepare(
          "UPDATE user_profile_identities SET canonical_login = ? WHERE provider = 'github' AND subject = '102'",
        )
        .run("renamed-secondary");
    } finally {
      foreign.close();
    }
    const next = await prepareSessionCatalogSourceActorProjector(source);
    expect(next(actor)?.label).toBe("Changed Person");
    const changed = await prepareSessionCatalogGitHubLinker({
      participants,
      owners: ["github:SECONDARY", "github:RENAMED-SECONDARY"],
    });
    expect(changed.resolveOwner("github:SECONDARY")).toBeUndefined();
    expect(changed.resolveOwner("github:RENAMED-SECONDARY")?.label).toBe("Changed Person");
  });
});

it.each(["owner", "foreign"] as const)(
  "preserves %s change semantics while an accepted catalog read awaits disclosure",
  async (writer) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const source = syncGitHubIdentity({
        identity: { accountId: 201, login: "source", name: "Before" },
        authenticationAlias: { kind: "email", email: "source@example.test" },
      });
      const target = syncGitHubIdentity({
        identity: { accountId: 202, login: "target" },
        authenticationAlias: { kind: "email", email: "target@example.test" },
      });
      const accepted = createDeferredCore();
      const release = createDeferredCore();
      const execute = stateReads.executeExistingOpenClawStateRead;
      vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementationOnce(
        async (...args) => {
          const result = await execute(...args);
          accepted.resolve();
          await release.promise;
          return result;
        },
      );
      const actor = { type: "human", source: "profile", id: source.id } as const;
      const request = {
        pluginId: "fixture",
        sourceDomain: "fixture",
        actors: [actor],
      };
      const pending = prepareSessionCatalogSourceActorProjector(request);
      try {
        await Promise.race([
          accepted.promise,
          pending.then(() => {
            throw new Error("Read was not held");
          }),
        ]);
        if (writer === "owner") {
          linkEmail("source@example.test", target.id);
        } else {
          const foreign = openNodeSqliteDatabase(openOpenClawStateDatabase().path);
          try {
            foreign
              .prepare("UPDATE user_profiles SET display_name = ? WHERE id = ?")
              .run("After", source.id);
            foreign
              .prepare(
                "UPDATE user_profile_identities SET canonical_login = ? WHERE provider = 'github' AND subject = '201'",
              )
              .run("renamed");
          } finally {
            foreign.close();
          }
        }
      } finally {
        release.resolve();
      }
      if (writer === "owner") {
        await expect(pending).rejects.toThrow("identities changed");
      } else {
        expect((await pending)(actor)?.label).toBe("Before");
        expect((await prepareSessionCatalogSourceActorProjector(request))(actor)?.label).toBe(
          "After",
        );
        const linker = await prepareSessionCatalogGitHubLinker({
          participants: [],
          owners: ["github:renamed"],
        });
        expect(linker.resolveOwner("github:renamed")?.id).toBe(source.id);
      }
    });
  },
);
