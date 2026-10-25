import { describe, expect, it } from "vitest";
import { readSkillLibrary, saveSkillLibrary } from "../../skills/library/service.js";
import type { SkillLibraryAuthority } from "../../skills/library/store.js";
import { listWorkshopChanges, recordWorkshopChange } from "../../skills/workshop/changes.js";
import type { WorkshopChange } from "../../skills/workshop/changes.kernel.js";
import { ensureGatewayOwnerProfile } from "../../state/user-profiles.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s skill storage first use",
  (engine) => {
    useMixedAgentPair(engine, engine);

    it("publishes and reads a personal library skill through the state worker", async () => {
      const profile = admit(() => ensureGatewayOwnerProfile("Synthetic skill author"));
      const authority: SkillLibraryAuthority = {
        profileId: profile.id,
        scopes: ["operator.read", "operator.write"],
        getConfig: () => ({}),
        assertCurrent: () => {},
      };
      const content =
        "---\nname: storage-guide\ndescription: Synthetic storage conformance skill\n---\n# Guide\nRead the current task before acting.\n";
      const saved = await saveSkillLibrary(authority, {
        slug: "storage-guide",
        content,
        expectedRevision: null,
      });
      expect(saved).toMatchObject({
        state: "published",
        entry: { slug: "storage-guide", ownerProfileId: profile.id },
      });
      await expect(readSkillLibrary(authority, saved.entry.skillId)).resolves.toMatchObject({
        content,
        entry: { revision: saved.entry.revision, ownerProfileId: profile.id },
      });
    });

    it("records the first workshop changes and reads them through the state worker", async () => {
      const first: WorkshopChange = {
        id: "first-workshop-change",
        agentId: "main",
        skillName: "storage-guide",
        action: "create",
        actor: "user",
        summary: "Created a synthetic skill",
        createdAtMs: 1_000,
      };
      const second: WorkshopChange = {
        ...first,
        id: "second-workshop-change",
        action: "patch",
        summary: "Updated the synthetic skill",
      };
      await recordWorkshopChange(first);
      await recordWorkshopChange(second);
      await expect(listWorkshopChanges("main")).resolves.toEqual([second, first]);
    });
  },
);
