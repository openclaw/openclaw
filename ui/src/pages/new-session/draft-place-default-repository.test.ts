import { describe, expect, it, vi } from "vitest";
import { parseProjectGitUrl } from "../../../../src/projects/project-git-url.ts";
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
  it.each(["https://ghe.example.test/", "ssh://git@ghe.example.test/", "git@ghe.example.test:"])(
    "accepts the configured host in %s clone URLs",
    (prefix) =>
      expect(parseProjectGitUrl(`${prefix}acme/private-repo.git`, "ghe.example.test")).toEqual({
        url: repository.cloneUrl,
        name: "private-repo",
      }),
  );

  it.each(["saved", "active"])("rejects a %s repository from the previous host", (source) => {
    const f = createRepositoryFixture();
    f.readPreference.mockReturnValue(source === "saved" ? { remoteProject: repository } : {});
    vi.spyOn(f.browser, "projectsReady", "get").mockReturnValue(true);
    vi.spyOn(f.browser, "githubHost", "get").mockReturnValue("replacement.example");
    f.state.adoptAgentDefaults();
    if (source === "active") {
      f.state.selectRemoteProject(repository);
    }
    f.state.restorePreferenceSelections();
    expect(f.browser.remoteProject).toBeNull();
  });

  it.each(["saved-repository", "explicit"] as const)(
    "keeps a %s destination when the default repository catalog arrives later",
    (source) => {
      const where: NewSessionWhere =
        source === "explicit" ? { kind: "local" } : { kind: "cloud", id: "selected-worker" };
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
        configured.state.selectDevice("");
      }
      expect(configured.state.preferenceSelection().where).toEqual(where);
      expect(configured.state.placementPreferenceReady).toBe(false);

      publishCatalog();
      configured.state.restorePreferenceSelections();
      expect(configured.browser.remoteProject?.identity).toBe("acme/private-repo");
      expect(configured.state.preferenceSelection().where, where.kind).toEqual(where);
      expect(configured.state.placementPreferenceReady).toBe(true);
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
