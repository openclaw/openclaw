import { expect, it } from "vitest";
import { linkEmail, syncGitHubIdentity } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createSessionCatalogGitHubLinker,
  createSessionCatalogSourceParticipantProjector,
} from "./session-catalog-identity.js";

it("links every verified account to one person while exporting only the primary account", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
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
    expect(
      createSessionCatalogSourceParticipantProjector()({
        pluginId: "fixture",
        sourceDomain: "fixture",
        identity: { type: "profile", id: secondary.id },
      }).identity,
    ).toMatchObject({ idKind: "github-account", id: "101" });
  });
});
