import { afterEach, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as nativeProfiles from "../state/user-profile-list.native.js";
import { linkEmail, syncGitHubIdentity } from "../state/user-profile-writes.worker.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createSessionCatalogGitHubLinker as createLinker,
  createSessionCatalogSourceActorProjector as createActorProjector,
  prepareSessionCatalogGitHubLinker as prepareLinker,
  prepareSessionCatalogSourceActorProjector as prepareActorProjector,
  prepareSessionCatalogSourceParticipantProjector as prepareParticipantProjector,
} from "./session-catalog-identity.js";

afterEach(() => vi.restoreAllMocks());

const sourceScope = { pluginId: "fixture", sourceDomain: "fixture" };
const remoteParticipant = (id: string, idKind = "github-account") => ({
  identity: { type: "remote" as const, pluginId: "fixture", domain: "fixture", idKind, id },
});
const profile = (accountId: number, login: string, name?: string) =>
  syncGitHubIdentity({
    identity: { accountId, login, ...(name ? { name } : {}) },
    authenticationAlias: { kind: "email", email: `${login}@example.test` },
  });

it("projects lazy, merged and refreshed identities through legacy and prepared readers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const primary = profile(101, "primary", "One Person");
    const secondary = profile(102, "secondary");
    const primaryActor = { type: "human", source: "profile", id: primary.id } as const;
    const nativeReads = vi.spyOn(nativeProfiles, "getUserProfileDisplaysNative");
    const project = createActorProjector({ ...sourceScope, actors: [primaryActor] });
    expect(project(undefined)).toBeUndefined();
    expect(project({ type: "system" })).toEqual({ type: "system" });
    expect(nativeReads).not.toHaveBeenCalled();
    expect(project(primaryActor)?.identity).toMatchObject({ idKind: "github-account", id: "101" });
    expect(project(primaryActor)?.identity).toMatchObject({ idKind: "github-account", id: "101" });
    expect(nativeReads).toHaveBeenCalledTimes(1);
    expect(project({ ...primaryActor, id: secondary.id })?.identity).toMatchObject({
      idKind: "github-account",
      id: "102",
    });
    expect(nativeReads).toHaveBeenCalledTimes(2);
    nativeReads.mockRestore();
    const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const remote = remoteParticipant("remote", "profile");
    const unlinked = await prepareLinker({ participants: [remote] });
    expect(unlinked.linkParticipant(remote)).toBe(remote);
    expect(unlinked.resolveOwner("profile:missing")).toBeUndefined();
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    linkEmail("secondary@example.test", primary.id);
    const linkedIdentity = { type: "profile", id: primary.id };
    const linker = createLinker();
    for (const id of ["101", "102"]) {
      expect(linker.linkParticipant(remoteParticipant(id)).identity).toEqual(linkedIdentity);
    }
    expect(linker.resolveOwner("github:secondary")?.id).toBe(primary.id);
    const database = openOpenClawStateDatabase();
    const prepare = database.db.prepare.bind(database.db);
    const hostSql = vi.spyOn(database.db, "prepare").mockImplementation((sql: string) => {
      if (/user_profiles|user_profile_identities/.test(sql)) {
        throw new Error("Profile catalog projection executed SQL on the host");
      }
      return prepare(sql);
    });
    const actor = { type: "human", source: "profile", id: secondary.id } as const;
    const source = { ...sourceScope, actors: [actor] };
    const portable = await prepareActorProjector(source);
    expect(portable(actor)?.identity).toMatchObject({ idKind: "github-account", id: "101" });
    const senderIdentity = { type: "profile", id: secondary.id } as const;
    const sender = await prepareParticipantProjector([senderIdentity]);
    expect(sender.project({ ...sourceScope, identity: senderIdentity }).identity).toMatchObject({
      idKind: "github-account",
      id: "101",
    });
    const participants = ["101", "102"].map((id) => remoteParticipant(id));
    const prepared = await prepareLinker({
      participants,
      owners: ["github:SECONDARY", "profile:missing"],
    });
    expect(
      participants.map((participant) => prepared.linkParticipant(participant).identity),
    ).toEqual([linkedIdentity, linkedIdentity]);
    expect(prepared.resolveOwner("github:SECONDARY")?.id).toBe(primary.id);
    expect(prepared.resolveOwner("profile:missing")).toBeUndefined();
    hostSql.mockRestore();

    {
      using foreign = openNodeSqliteDatabase(database.path);
      foreign
        .prepare("UPDATE user_profiles SET display_name = ? WHERE id = ?")
        .run("Changed Person", primary.id);
      foreign
        .prepare(
          "UPDATE user_profile_identities SET canonical_login = ? WHERE provider = 'github' AND subject = '102'",
        )
        .run("renamed-secondary");
    }
    const next = await prepareActorProjector(source);
    expect(next(actor)?.label).toBe("Changed Person");
    const changed = await prepareLinker({
      participants,
      owners: ["github:SECONDARY", "github:RENAMED-SECONDARY"],
    });
    expect(changed.resolveOwner("github:SECONDARY")).toBeUndefined();
    expect(changed.resolveOwner("github:RENAMED-SECONDARY")?.label).toBe("Changed Person");
  });
});
