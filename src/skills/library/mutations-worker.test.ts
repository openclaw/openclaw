import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { GatewayOperatorRolesConfig } from "../../config/types.gateway.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { linkEmail, setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { SkillLibraryError } from "../skill-library-error.js";
import { prepareSkillLibraryBundle, skillLibraryRevisionDir } from "./bundle.js";
import { content, draft, useSkillLibraryFixture, zipBytes } from "./service.test-support.js";
import type { SkillLibraryAuthority } from "./store.js";

const { fixture } = useSkillLibraryFixture();

it("saves, mutates, and settles an upload without caller-thread SQL", async () => {
  const { options, lib } = fixture();
  await openOpenClawStateDatabase(options).walMaintenance.stop();
  const sql = observeHostDataSql();
  try {
    const { skillId, revision } = (await lib.save()).entry;
    await expect(lib.change({ skillId, revision }, "disable")).resolves.toMatchObject({
      entry: { enabled: false },
    });
    const bytes = await zipBytes();
    const upload = await lib.begin(bytes, "uploaded");
    const chunk = () => lib.chunk(upload.uploadId, bytes);
    const commit = () => lib.commit(upload.uploadId);
    const chunks = await Promise.allSettled([chunk(), chunk()]);
    expect(chunks.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = chunks.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(SkillLibraryError) });
    expect(rejected).toMatchObject({ reason: { code: "CONFLICT" } });
    const receipt = await commit();
    expect(receipt).toMatchObject({ state: "published", entry: { slug: "uploaded" } });
    await expect(commit()).resolves.toMatchObject({ ...receipt, state: "unchanged" });
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("publishes immutable files before SQL and retains them when the transaction fails", async () => {
  const { options, lib } = fixture();
  const { skillId, revision } = (await lib.save()).entry;
  const nextContent = `${content}\nUncommitted revision`;
  const next = { ...draft(), content: nextContent, skillId, expectedRevision: revision };
  const bundle = prepareSkillLibraryBundle([
    { path: "SKILL.md", content: nextContent },
    ...draft().files,
  ]);
  const directory = skillLibraryRevisionDir(skillId, bundle.revision, options.env);
  openOpenClawStateDatabase(options).db.exec(`
      CREATE TRIGGER reject_library_revision BEFORE INSERT ON skill_library_revisions
      BEGIN SELECT RAISE(ABORT, 'publication transaction refused'); END;
    `);
  await expect(lib.save(next)).rejects.toThrow("publication transaction refused");
  expect(await fs.readFile(path.join(directory, "SKILL.md"), "utf8")).toBe(nextContent);
  expect(await fs.readdir(path.dirname(directory))).not.toContainEqual(
    expect.stringMatching(/^\.staging-/),
  );
  expect(await lib.read(skillId)).toMatchObject({
    content,
    entry: { revision },
    revisions: [{ revision }],
  });
});

it.each(["role", "alias", "upload expiry"])(
  "rejects stale %s after file publication without a SQL pointer",
  async (change) => {
    const { alice, options, lib } = fixture();
    const blocked = ensureProfileForEmail("blocked@example.test", options);
    setUserProfileRole(blocked.id, "blocked", options);
    const sessions = { others: "none" } as const;
    const roles: GatewayOperatorRolesConfig = {
      default: "writer",
      definitions: {
        writer: { sessions, agents: "*", scopes: ["operator.read", "operator.write"] },
        blocked: { sessions, agents: [], scopes: [] },
      },
    };
    const authority: SkillLibraryAuthority = {
      ...alice,
      getConfig: () => ({ gateway: { roles } }),
    };
    const bytes = change === "upload expiry" ? await zipBytes() : undefined;
    const upload = bytes ? await lib.begin(bytes, "expiring") : undefined;
    if (upload && bytes) {
      await lib.chunk(upload.uploadId, bytes);
    }
    const rename = fs.rename;
    let changed = false;
    const barrier = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (String(source).includes(".staging-") && !changed) {
        changed = true;
        if (upload) {
          openOpenClawStateDatabase(options)
            .db.prepare("UPDATE skill_library_uploads SET expires_at = 1 WHERE upload_id = ?")
            .run(upload.uploadId);
        } else if (change === "role") {
          setUserProfileRole(alice.profileId!, "blocked", options);
        } else {
          linkEmail("alice@example.test", blocked.id, options);
        }
      }
    });
    try {
      await expect(
        upload ? lib.commit(upload.uploadId) : lib.save(draft(), authority),
      ).rejects.toMatchObject({
        code: upload ? "NOT_FOUND" : expect.stringMatching(/^(AUTHORITY_EXPIRED|FORBIDDEN)$/),
      });
      expect(changed).toBe(true);
    } finally {
      barrier.mockRestore();
    }
    expect((await lib.list()).entries).toEqual([]);
  },
);
