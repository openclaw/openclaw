import { describe, expect, it, vi } from "vitest";
import { buildSelectedSessionCreateParams } from "./draft-create-params.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import type { NewSessionWhere } from "./preferences.ts";

const repository = {
  identity: "acme/private-repo",
  cloneUrl: "https://ghe.example.test/acme/private-repo.git",
};
const branchedRepository = { ...repository, defaultBranch: "main" };

function delayedCatalog(
  { browser }: ReturnType<typeof createRepositoryFixture>,
  project = repository,
) {
  let ready = false;
  vi.spyOn(browser, "projectsReady", "get").mockImplementation(() => ready);
  vi.spyOn(browser, "defaultRemoteProject", "get").mockImplementation(() =>
    ready ? project : null,
  );
  vi.spyOn(browser, "defaultRemoteProjectProfileId", "get").mockImplementation(() =>
    ready ? "aws" : "",
  );
  return () => {
    ready = true;
  };
}

describe("DraftPlaceState configured repository defaults", () => {
  it.each(["saved", "active"] as const)(
    "validates %s clone selections using the accepted Git URL forms",
    (source) => {
      for (const host of ["ghe.example.test", "old.ghe.example.test"]) {
        for (const cloneUrl of [
          `https://${host}/acme/private-repo.git`,
          `ssh://git@${host}/acme/private-repo.git`,
          `git@${host}:acme/private-repo.git`,
        ]) {
          const configured = createRepositoryFixture();
          const project = { identity: "acme/private-repo", cloneUrl };
          configured.readPreference.mockReturnValue(
            source === "saved" ? { remoteProject: project } : {},
          );
          vi.spyOn(configured.browser, "projectsReady", "get").mockReturnValue(true);
          vi.spyOn(configured.browser, "githubHost", "get").mockReturnValue("ghe.example.test");
          configured.state.adoptAgentDefaults();
          if (source === "active") {
            configured.state.selectRemoteProject(project);
          }
          configured.state.restorePreferenceSelections();
          expect(configured.browser.remoteProject, cloneUrl).toEqual(
            host === "ghe.example.test" ? project : null,
          );
        }
      }
    },
  );

  it.each(["saved-repository", "explicit"] as const)(
    "keeps a %s destination when the default repository catalog arrives later",
    (source) => {
      const destinations: NewSessionWhere[] = [
        { kind: "cloud", id: "selected-worker" },
        { kind: "device", id: "desktop" },
        { kind: "auto-device" },
        ...(source === "explicit" ? [{ kind: "local" } as const] : []),
      ];
      for (const where of destinations) {
        const configured = createRepositoryFixture({
          cloudProfiles: [
            { id: "aws", providerId: "crabbox" },
            { id: "selected-worker", providerId: "crabbox" },
          ],
        });
        configured.readPreference.mockReturnValue(
          source === "explicit" ? {} : { where, remoteProject: repository },
        );
        const publishCatalog = delayedCatalog(configured);
        vi.spyOn(configured.browser, "projectsLoading", "get").mockImplementation(
          () => !configured.browser.projectsReady,
        );
        configured.state.adoptAgentDefaults();
        configured.state.restorePreferenceSelections();
        if (source === "explicit") {
          if (where.kind === "cloud") {
            configured.state.selectCloudProfile(where.id);
          } else {
            configured.state.selectDevice(
              where.kind === "device" ? where.id : "",
              where.kind === "auto-device",
            );
          }
        }
        expect(configured.state.preferenceSelection().where).toEqual(where);
        expect(configured.state.placementPreferenceReady).toBe(false);

        publishCatalog();
        configured.state.restorePreferenceSelections();
        expect(configured.browser.remoteProject?.identity).toBe("acme/private-repo");
        expect(configured.state.preferenceSelection().where, where.kind).toEqual(where);
        expect(configured.state.placementPreferenceReady).toBe(true);
      }
    },
  );

  it.each(["unrelated branch", "missing worker", "saved local"] as const)(
    "restores configured repository placement: %s",
    (scenario) => {
      const noRef = scenario === "unrelated branch";
      const missing = scenario === "missing worker";
      const legacy = scenario === "saved local";
      const f = createRepositoryFixture();
      const project = noRef ? repository : branchedRepository;
      f.readPreference.mockReturnValue(
        noRef
          ? { folder: "/workspace", baseRef: "gateway/old-branch" }
          : {
              folder: "/workspace",
              remoteProject: project,
              ...(legacy ? { baseRef: "topic/saved", where: { kind: "local" as const } } : {}),
            },
      );
      let ready = missing;
      vi.spyOn(f.browser, "projectsReady", "get").mockImplementation(() => ready);
      vi.spyOn(f.browser, "defaultRemoteProject", "get").mockImplementation(() =>
        legacy && !ready ? null : project,
      );
      vi.spyOn(f.browser, "defaultRemoteProjectProfileId", "get").mockImplementation(() =>
        legacy && !ready ? "" : missing ? "missing-worker-profile" : "aws",
      );
      if (noRef) {
        vi.spyOn(f.browser, "projectsLoading", "get").mockImplementation(() => !ready);
      }
      f.state.adoptAgentDefaults();
      f.state.restorePreferenceSelections();
      expect(f.browser.remoteProject).toBeNull();
      if (missing) {
        expect(f.state).toMatchObject({ remoteRepository: undefined, cloudProfileId: "" });
        return;
      }
      expect(f.state.placementPreferenceReady).toBe(false);
      ready = true;
      f.state.restorePreferenceSelections();
      expect(f.state.cloudProfileId).toBe("aws");
      if (legacy) {
        expect(f.browser.remoteProject?.cloneUrl).toBe(repository.cloneUrl);
        expect(f.state.remoteRepository).toEqual({ url: repository.cloneUrl, ref: "topic/saved" });
        return;
      }
      expect(f.browser.remoteProject).toEqual(repository);
      expect(f.state.baseRef).toBe("");
      expect(f.state.remoteRepository).toEqual({ url: repository.cloneUrl });
      expect(
        buildSelectedSessionCreateParams(f.state, {
          message: "Inspect the issue",
          visibility: "normal",
        }),
      ).toMatchObject({ message: "", repository: { url: repository.cloneUrl } });
      expect(f.state.placementPreferenceReady).toBe(true);
      f.persistPreference.mockClear();
      f.state.clearProjectSelection();
      expect(f.persistPreference).toHaveBeenCalledWith(
        "main",
        "/workspace",
        expect.objectContaining({ defaultRepositoryOptOut: true, remoteProject: null }),
      );
    },
  );
});
