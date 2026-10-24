import { expect, it } from "vitest";
import type {
  SkillsLibraryListResult,
  SkillsLibraryMutateParams,
  SkillsLibraryReadResult,
  SkillsLibraryReceipt,
  SkillsLibrarySaveParams,
} from "../../../../packages/gateway-protocol/src/schema/skill-library.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  createSkillLibraryWireInstance,
  SKILL_LIBRARY_ALICE,
  SKILL_LIBRARY_BOB,
  SKILL_LIBRARY_WRITER_SCOPES,
  SkillLibraryWireClient,
} from "./skill-library-wire-fixture.js";

const draft: SkillsLibrarySaveParams = {
  expectedRevision: null,
  slug: "boundary-proof",
  content: "---\nname: boundary-proof\ndescription: Synthetic library boundary proof.\n---\n",
};
type Entry = SkillsLibraryReceipt["entry"];
const save = (client: SkillLibraryWireClient, entry?: Entry) =>
  client.request<SkillsLibraryReceipt>("skills.library.save", {
    ...draft,
    ...(entry ? { skillId: entry.skillId, expectedRevision: entry.revision } : {}),
  });
const mutate = (
  client: SkillLibraryWireClient,
  entry: Entry,
  action: SkillsLibraryMutateParams["action"],
) =>
  client.request<SkillsLibraryReceipt>("skills.library.mutate", {
    skillId: entry.skillId,
    expectedRevision: entry.revision,
    action,
  });
const read = (client: SkillLibraryWireClient, entry: Entry, revision?: string) =>
  client.request<SkillsLibraryReadResult>("skills.library.read", {
    skillId: entry.skillId,
    ...(revision ? { revision } : {}),
  });
const list = (client: SkillLibraryWireClient) =>
  client.request<SkillsLibraryListResult>("skills.library.list", {});
async function expectLibraryError(operation: Promise<unknown>, code: string) {
  await expect(operation).rejects.toMatchObject({
    error: { code: "INVALID_REQUEST", details: { code: `SKILL_LIBRARY_${code}` } },
  });
}

it("isolates wire identities and caps skill-library mutation authority", async () => {
  const instance = await createSkillLibraryWireInstance();
  const clients: SkillLibraryWireClient[] = [];
  await runQaGatewayFixture(
    async () => {
      await instance.startGateway();
      const connect = async (options?: Parameters<typeof SkillLibraryWireClient.connect>[1]) => {
        const connected = await SkillLibraryWireClient.connect(instance, options);
        clients.push(connected.client);
        return connected;
      };
      const { client: localAdmin, hello: adminHello } = await connect();
      expect(adminHello.auth?.scopes).toContain("operator.admin");
      await expect(list(localAdmin)).resolves.toMatchObject({
        profileId: GATEWAY_OWNER_PROFILE_ID,
        multipleProfiles: false,
        defaultTarget: "workspace",
        canManageWorkspace: true,
      });
      // Shared-secret connections are the same durable owner.
      const { client: otherOwner } = await connect();
      await expect(list(otherOwner)).resolves.toMatchObject({
        profileId: GATEWAY_OWNER_PROFILE_ID,
      });
      const ownerSkill = await save(localAdmin);
      expect((await list(otherOwner)).entries).toContainEqual(
        expect.objectContaining({ skillId: ownerSkill.entry.skillId }),
      );
      const user = (email: string, scopes?: string[]) =>
        connect({ email, scopes, buildId: adminHello.server.buildId });
      const { client: aliceAdmin, hello: aliceAdminHello } = await user(SKILL_LIBRARY_ALICE, [
        "operator.admin",
        ...SKILL_LIBRARY_WRITER_SCOPES,
      ]);
      expect(aliceAdminHello.auth?.scopes).toContain("operator.admin");
      const solo = await list(aliceAdmin);
      expect(solo).toMatchObject({
        profileId: expect.any(String),
        multipleProfiles: false,
        defaultTarget: "workspace",
      });
      const { client: alice, hello: aliceHello } = await user(SKILL_LIBRARY_ALICE);
      const { client: bob, hello: bobHello } = await user(SKILL_LIBRARY_BOB);
      for (const hello of [aliceHello, bobHello]) {
        expect(hello.auth?.scopes?.toSorted()).toEqual([...SKILL_LIBRARY_WRITER_SCOPES].toSorted());
      }
      const aliceList = await list(alice);
      const bobList = await list(bob);
      expect(aliceList).toMatchObject({
        profileId: solo.profileId,
        multipleProfiles: true,
        defaultTarget: "personal",
        canManageWorkspace: false,
      });
      expect(bobList.profileId).toEqual(expect.any(String));
      expect(bobList.profileId).not.toBe(aliceList.profileId);
      expect((await alice.request<{ profile: { id: string } }>("users.self", {})).profile.id).toBe(
        aliceList.profileId,
      );
      const profiles = await localAdmin.request<{ profiles: Array<{ id: string }> }>(
        "users.list",
        {},
      );
      expect(profiles.profiles.map((profile) => profile.id).toSorted()).toEqual(
        [GATEWAY_OWNER_PROFILE_ID, aliceList.profileId, bobList.profileId].toSorted(),
      );
      const created = await save(alice);
      expect(created).toMatchObject({
        entry: {
          ownerProfileId: aliceList.profileId,
          authorProfileId: aliceList.profileId,
          shared: false,
          canEdit: true,
        },
      });
      expect((await list(bob)).entries.map((entry) => entry.skillId)).not.toContain(
        created.entry.skillId,
      );
      await expectLibraryError(read(bob, created.entry), "NOT_FOUND");
      await expectLibraryError(read(bob, created.entry, created.entry.revision), "NOT_FOUND");
      await expectLibraryError(save(bob, created.entry), "NOT_FOUND");
      await expectLibraryError(mutate(bob, created.entry, "remove"), "NOT_FOUND");
      await mutate(alice, created.entry, "share");
      expect((await read(bob, created.entry)).entry).toMatchObject({
        shared: true,
        canEdit: false,
        ownerProfileId: aliceList.profileId,
      });
      await expectLibraryError(save(bob, created.entry), "FORBIDDEN");
      for (const action of ["unshare", "remove", "transfer"] as const) {
        await expectLibraryError(mutate(bob, created.entry, action), "FORBIDDEN");
      }
      await expectLibraryError(mutate(alice, created.entry, "transfer"), "FORBIDDEN");
      const transferred = await mutate(aliceAdmin, created.entry, "transfer");
      expect(transferred).toMatchObject({
        target: "team",
        entry: {
          skillId: created.entry.skillId,
          revision: created.entry.revision,
          ownerProfileId: null,
          authorProfileId: aliceList.profileId,
          shared: true,
        },
      });
      expect((await read(bob, created.entry)).entry.canEdit).toBe(false);
      await expectLibraryError(mutate(alice, created.entry, "remove"), "FORBIDDEN");
    },
    async () => {
      for (const client of clients.toReversed()) {
        await client.close();
      }
    },
    () => instance.cleanup(),
  );
}, 180_000);
