/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import {
  createUpdatesViewDom,
  createUpdatesViewProps as createProps,
} from "./updates.test-support.ts";
import { renderUpdates } from "./updates.ts";

let container: HTMLDivElement;
let row: ReturnType<typeof createUpdatesViewDom>["row"];

beforeEach(async () => {
  await i18n.setLocale("en");
  ({ container, row } = createUpdatesViewDom());
});

it("renders bounded dev commit details only when supplied", () => {
  const props = createProps({
    update: {
      updateSchedule: {
        channel: "dev",
        autoEnabled: false,
        install: {
          kind: "git",
          git: {
            status: "behind",
            currentSha: "a".repeat(40),
            upstreamSha: "b".repeat(40),
            commitsBehind: 2,
          },
        },
        target: {
          kind: "git",
          upstreamRef: "origin/main",
          upstreamSha: "b".repeat(40),
          commitsBehind: 2,
        },
      },
      updateAvailable: {
        currentVersion: "2026.8.1",
        latestVersion: "2026.8.1",
        channel: "dev",
        currentSha: "a".repeat(40),
        upstreamRef: "origin/main",
        upstreamSha: "b".repeat(40),
        commitsBehind: 2,
        commits: [
          { sha: "b123456", subject: "Add held update campaigns" },
          { sha: "a987654", subject: "Show dev commit details" },
        ],
      },
    },
  });
  render(renderUpdates(props), container);

  expect(row("Commits").querySelectorAll("[role='listitem']")).toHaveLength(2);
  expect(row("Commits").textContent).toContain("b123456");
  expect(row("Commits").textContent).toContain("Show dev commit details");
  expect(row("Status").textContent).toContain("Update available 2 commits behind");
  expect(
    [...row("Status").querySelectorAll(".update-git-revisions code")].map(
      (code) => code.textContent,
    ),
  ).toEqual(["aaaaaaaa", "bbbbbbbb"]);
  expect(row("Status").textContent).not.toContain("Up to date");
  expect(row("Status").querySelector(".settings-status__dot")).toBeNull();

  const refreshedGit = {
    status: "behind" as const,
    currentSha: "a".repeat(40),
    upstreamSha: "c".repeat(40),
    commitsBehind: 2,
  };
  render(
    renderUpdates(
      createProps({
        update: {
          ...props.update,
          updateSchedule: {
            channel: "dev",
            autoEnabled: false,
            install: { kind: "git", git: refreshedGit },
          },
        },
      }),
    ),
    container,
  );
  expect(container.querySelector(".updates-commit-list")).toBeNull();
  expect(
    [...row("Status").querySelectorAll(".update-git-revisions code")].map(
      (code) => code.textContent,
    ),
  ).toEqual(["aaaaaaaa", "cccccccc"]);

  render(renderUpdates(createProps()), container);
  expect(container.querySelector(".updates-commit-list")).toBeNull();
});
