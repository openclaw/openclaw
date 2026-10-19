import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type {
  SkillsLibraryListResult,
  SkillsLibraryMutateParams,
  SkillsLibraryReadResult,
  SkillsLibraryReceipt,
  SkillsLibrarySaveParams,
  SkillsLibraryUploadParams,
  SkillsLibraryUploadResult,
} from "../../../../packages/gateway-protocol/src/schema/skill-library.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  createSkillLibraryWireInstance,
  decodedSkillLibraryFiles,
  SKILL_LIBRARY_ALICE,
  SKILL_LIBRARY_BOB,
  SKILL_LIBRARY_WRITER_SCOPES,
  SkillLibraryWireClient,
} from "./skill-library-wire-fixture.js";

function skillLibraryProofBundle(reference = "alice-reference-v1\n"): SkillsLibrarySaveParams {
  return {
    expectedRevision: null,
    slug: "boundary-proof",
    content:
      "---\nname: boundary-proof\ndescription: Synthetic library boundary proof.\n---\nRead references/value.txt and run scripts/report.mjs beside this SKILL.md.\n",
    files: [
      { path: "references/value.txt", content: reference },
      {
        path: "scripts/report.mjs",
        content: "console.log('synthetic helper');\n",
        executable: true,
      },
      { path: "references/binary.dat", content: "AAEC/w==", encoding: "base64" },
    ],
  };
}

async function expectLibraryError(operation: Promise<unknown>, code: string, extra = {}) {
  await expect(operation).rejects.toMatchObject({
    error: { code: "INVALID_REQUEST", details: { code: `SKILL_LIBRARY_${code}`, ...extra } },
  });
}

type Entry = SkillsLibraryReceipt["entry"];
const save = (client: SkillLibraryWireClient, bundle: SkillsLibrarySaveParams, entry?: Entry) =>
  client.request<SkillsLibraryReceipt>("skills.library.save", {
    ...bundle,
    ...(entry ? { skillId: entry.skillId, expectedRevision: entry.revision } : {}),
  });
function mutate(
  client: SkillLibraryWireClient,
  entry: Entry,
  action: SkillsLibraryMutateParams["action"],
  revision?: string,
) {
  return client.request<SkillsLibraryReceipt>("skills.library.mutate", {
    skillId: entry.skillId,
    expectedRevision: entry.revision,
    action,
    ...(revision ? { revision } : {}),
  });
}

function expectBundle(read: SkillsLibraryReadResult, bundle: SkillsLibrarySaveParams) {
  expect(read.content).toBe(bundle.content);
  expect(decodedSkillLibraryFiles(read.files)).toEqual(decodedSkillLibraryFiles(bundle.files!));
}

it("isolates identities and publishes optimistic skill revisions", async () => {
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
      const list = (client: SkillLibraryWireClient) =>
        client.request<SkillsLibraryListResult>("skills.library.list", {});
      await expect(list(localAdmin)).resolves.toMatchObject({
        profileId: null,
        multipleProfiles: false,
        defaultTarget: "workspace",
        canManageWorkspace: true,
      });
      // Multiple real anonymous operator connections must not masquerade as multiple people.
      const { client: otherAnonymous } = await connect();
      await expect(list(otherAnonymous)).resolves.toMatchObject({
        multipleProfiles: false,
        defaultTarget: "workspace",
      });
      await expectLibraryError(
        localAdmin.request("skills.library.save", skillLibraryProofBundle()),
        "IDENTITY_REQUIRED",
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
        defaultSelectionLimit: 64,
      });
      expect(solo.defaultSelectionNotice).toBeUndefined();

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
      expect(bobList).toMatchObject({
        multipleProfiles: true,
        defaultTarget: "personal",
        canManageWorkspace: false,
      });
      expect(bobList.profileId).toEqual(expect.any(String));
      expect(bobList.profileId).not.toBe(aliceList.profileId);
      const self = await alice.request<{ profile: { id: string } }>("users.self", {});
      expect(self.profile.id).toBe(aliceList.profileId);
      const profiles = await localAdmin.request<{ profiles: Array<{ id: string }> }>(
        "users.list",
        {},
      );
      expect(profiles.profiles).toHaveLength(3);
      expect(profiles.profiles.map((profile) => profile.id)).toEqual(
        expect.arrayContaining([GATEWAY_OWNER_PROFILE_ID, aliceList.profileId, bobList.profileId]),
      );

      const original = skillLibraryProofBundle();
      const created = await save(alice, original);
      expect(created).toMatchObject({
        state: "published",
        target: "personal",
        sessionActivation: "new-sessions",
        entry: {
          ownerProfileId: aliceList.profileId,
          authorProfileId: aliceList.profileId,
          shared: false,
          canEdit: true,
        },
      });
      expect(created.nextAction).toEqual(expect.any(String));
      expect(created.nextAction.length).toBeGreaterThan(0);
      expect(created.entry.revision).toMatch(/^[a-f0-9]{64}$/u);
      expect(created.entry.ownerLabel.trim().length).toBeGreaterThan(0);
      expect(created.entry.name).toMatch(/^s_boundary_[a-f0-9]{20}$/u);
      expect(created.entry.name.length).toBeLessThanOrEqual(32);
      const bobOwn = await save(bob, {
        ...original,
        content: original.content.replace("Synthetic library", "Bob private library"),
      });
      expect(bobOwn.entry.skillId).not.toBe(created.entry.skillId);
      expect(bobOwn.entry.name).not.toBe(created.entry.name);
      const read = (client: SkillLibraryWireClient, skillId: string, revision?: string) =>
        client.request<SkillsLibraryReadResult>("skills.library.read", {
          skillId,
          ...(revision ? { revision } : {}),
        });

      // Guessing an existing ID, including its known revision, grants no private access.
      for (const [reader, privateEntry] of [
        [bob, created.entry],
        [alice, bobOwn.entry],
      ] as const) {
        expect((await list(reader)).entries.map((entry) => entry.skillId)).not.toContain(
          privateEntry.skillId,
        );
        await expectLibraryError(read(reader, privateEntry.skillId), "NOT_FOUND");
        await expectLibraryError(
          read(reader, privateEntry.skillId, privateEntry.revision),
          "NOT_FOUND",
        );
        await expectLibraryError(save(reader, original, privateEntry), "NOT_FOUND");
        await expectLibraryError(mutate(reader, privateEntry, "remove"), "NOT_FOUND");
      }

      const initial = await read(alice, created.entry.skillId);
      expectBundle(initial, original);
      const edited = skillLibraryProofBundle("alice-reference-v2\n");
      const updated = await save(alice, edited, created.entry);
      expect(updated).toMatchObject({ state: "published", sessionActivation: "new-sessions" });
      expect(updated.entry.revision).not.toBe(created.entry.revision);
      await expectLibraryError(
        save(
          alice,
          {
            ...original,
            content: original.content + "Stale destructive edit.\n",
          },
          created.entry,
        ),
        "CONFLICT",
        { currentRevision: updated.entry.revision },
      );
      const current = await read(alice, created.entry.skillId);
      expectBundle(current, edited);
      expect(current.revisions.map((item) => item.revision).toSorted()).toEqual(
        [created.entry.revision, updated.entry.revision].toSorted(),
      );
      const old = await read(alice, created.entry.skillId, created.entry.revision);
      expectBundle(old, original);
      const unchanged = await save(
        alice,
        {
          ...edited,
          files: current.files.toReversed(),
        },
        updated.entry,
      );
      expect(unchanged).toMatchObject({
        state: "unchanged",
        entry: { revision: updated.entry.revision, updatedAt: updated.entry.updatedAt },
      });
      expect((await read(alice, created.entry.skillId)).revisions).toEqual(current.revisions);

      await mutate(alice, updated.entry, "share");
      expect((await read(bob, created.entry.skillId)).entry).toMatchObject({
        shared: true,
        canEdit: false,
        ownerProfileId: aliceList.profileId,
      });
      await expectLibraryError(save(bob, edited, updated.entry), "FORBIDDEN");
      for (const action of ["unshare", "remove", "rollback", "transfer"] as const) {
        await expectLibraryError(
          mutate(
            bob,
            updated.entry,
            action,
            action === "rollback" ? created.entry.revision : undefined,
          ),
          "FORBIDDEN",
        );
      }
      // Even the owner cannot self-promote a skill into team ownership on a capped connection.
      await expectLibraryError(mutate(alice, updated.entry, "transfer"), "FORBIDDEN");
      const transferred = await mutate(aliceAdmin, updated.entry, "transfer");
      expect(transferred).toMatchObject({
        target: "team",
        entry: {
          skillId: created.entry.skillId,
          revision: updated.entry.revision,
          ownerProfileId: null,
          authorProfileId: aliceList.profileId,
          shared: true,
        },
      });
      const teamRead = await read(bob, created.entry.skillId);
      expect(teamRead.entry.canEdit).toBe(false);
      expectBundle(teamRead, edited);
      await expectLibraryError(mutate(alice, updated.entry, "remove"), "FORBIDDEN");

      const { default: JSZip } = await import("jszip");
      const zipContent =
        "---\nname: upload-proof\ndescription: Synthetic quota boundary proof.\n---\n# Upload proof\n";
      const zip = new JSZip().file("SKILL.md", zipContent);
      const bytes = await zip.generateAsync({ type: "nodebuffer" });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const upload = (client: SkillLibraryWireClient, params: SkillsLibraryUploadParams) =>
        client.request<SkillsLibraryUploadResult>("skills.library.upload", params);
      const begin = (client: SkillLibraryWireClient, slug: string) =>
        upload(client, { action: "begin", slug, sizeBytes: bytes.length, sha256 });
      for (let index = 0; index < 16; index++) {
        await expect(begin(alice, `pending-${index}`)).resolves.toMatchObject({
          uploadId: expect.any(String),
          offset: 0,
        });
      }
      // The quota follows the person, including their separate administrator connection.
      for (const client of [alice, aliceAdmin]) {
        await expectLibraryError(begin(client, "over-profile-limit"), "LIMIT");
      }
      const begun = await begin(bob, "upload-proof");
      if (!("uploadId" in begun)) {
        throw new Error("Expected Bob's upload ID");
      }
      await expect(
        upload(bob, {
          action: "chunk",
          uploadId: begun.uploadId,
          offset: 0,
          data: bytes.toString("base64"),
        }),
      ).resolves.toMatchObject({ uploadId: begun.uploadId, offset: bytes.length });
      const published = await upload(bob, { action: "commit", uploadId: begun.uploadId });
      if (!("entry" in published)) {
        throw new Error("Expected Bob's publication receipt");
      }
      expect(published).toMatchObject({
        state: "published",
        entry: { ownerProfileId: bobList.profileId },
      });
      expect((await read(bob, published.entry.skillId)).content).toBe(zipContent);
      await expect(
        upload(bob, { action: "commit", uploadId: begun.uploadId }),
      ).resolves.toMatchObject({
        state: "unchanged",
        entry: { skillId: published.entry.skillId },
      });
      await expectLibraryError(begin(alice, "still-over-profile-limit"), "LIMIT");
    },
    async () => {
      for (const client of clients.toReversed()) {
        await client.close();
      }
    },
    () => instance.cleanup(),
  );
}, 180_000);
