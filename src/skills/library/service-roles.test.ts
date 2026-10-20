import { expect, it } from "vitest";
import { resolveOperatorRolePolicyForAssignment } from "../../gateway/operator-role-policy.js";
import { syncGitHubIdentity } from "../../state/user-profile-writes.worker.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { readSkillLibrary, saveSkillLibrary } from "./service.js";
import type { SkillLibraryAuthority } from "./store.js";

const dirs = useStateDatabaseTempDirs();

it("publishes for a verified GitHub-mapped writer with a restrictive default role", async () => {
  const options = { env: { OPENCLAW_STATE_DIR: dirs.make("skill-library-roles-") } };
  const authenticationAlias = { kind: "email", email: "writer@example.test" } as const;
  const verified = syncGitHubIdentity(
    { identity: { accountId: 42, login: "Library-Writer" }, authenticationAlias },
    options,
  );
  const authority: SkillLibraryAuthority = {
    profileId: verified.id,
    scopes: ["operator.read", "operator.write"],
    assertCurrent() {},
    getConfig: () => ({
      gateway: {
        roles: {
          default: "guest",
          assignments: { byGithubLogin: { "library-writer": "writer" } },
          definitions: {
            guest: { sessions: { others: "none" }, agents: [], scopes: [] },
            writer: {
              sessions: { others: "none" },
              agents: "*",
              scopes: ["operator.read", "operator.write"],
            },
          },
        },
      },
    }),
  };
  const admittedRole = resolveOperatorRolePolicyForAssignment(
    verified.id,
    verified.role ?? null,
    authority.getConfig(),
    verified.githubIdentity?.login ?? null,
  );
  expect(admittedRole?.scopes).toEqual(["operator.read", "operator.write"]);

  const content = "---\nname: guide\ndescription: Test procedure\n---\n# Guide\n";
  const draft = { slug: "guide", content, expectedRevision: null };
  const saved = await saveSkillLibrary(authority, draft, options);
  expect(saved.entry.ownerProfileId).toBe(verified.id);
  expect((await readSkillLibrary(authority, saved.entry.skillId, undefined, options)).content).toBe(
    content,
  );

  syncGitHubIdentity(
    { identity: { accountId: 42, login: "Renamed-Writer" }, authenticationAlias },
    options,
  );
  await expect(
    saveSkillLibrary(authority, { ...draft, slug: "after-rename" }, options),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
