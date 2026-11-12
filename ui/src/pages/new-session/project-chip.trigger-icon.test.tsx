import { expect, it, onTestFinished, vi } from "vitest";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { mountProjectChip } from "./project-chip.test-support.tsx";

it("shows folder-git-2 by default, the selected project's icon, or GitHub for a remote repository", () => {
  const fixture = createRepositoryFixture();
  const { browser, changed } = fixture;
  onTestFinished(() => browser.disconnect());
  const projectId = vi.spyOn(browser, "projectId", "get").mockReturnValue("");
  const remoteProject = vi.spyOn(browser, "remoteProject", "get").mockReturnValue(null);
  const view = mountProjectChip(fixture, () => ({
    folder: "",
    workspace: "/workspace",
    projectId: browser.projectId,
    selectedRemoteProject: browser.remoteProject,
    projects: [],
    recents: [],
    projectQuery: "",
  }));
  const icon = () =>
    view.container.querySelector("#new-session-project-trigger .new-session-page__target-icon")!;

  expect(icon().querySelector("openclaw-workspace-icon")).toBeNull();

  projectId.mockReturnValue("alpha");
  changed();
  flush();
  const projectIcon = icon().querySelector("openclaw-workspace-icon");
  expect(projectIcon?.routeUrl).toMatch(/\/__openclaw__\/project-icon\/alpha$/);
  expect(projectIcon?.fallbackIcon).toBe("folderGit2");

  projectId.mockReturnValue("");
  remoteProject.mockReturnValue({
    identity: "acme-labs/alpha",
    cloneUrl: "https://github.com/acme-labs/alpha.git",
  });
  changed();
  flush();
  expect(icon().querySelector("openclaw-workspace-icon")).toBeNull();
  expect(icon().querySelector("svg.icon--filled")).not.toBeNull();
});
