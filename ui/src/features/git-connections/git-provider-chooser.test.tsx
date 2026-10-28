/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { GitProviderChooser } from "./git-provider-chooser.tsx";

it("offers available Git providers and dispatches the selected native connection", () => {
  const onSelect = vi.fn();
  const ui = mountSolid(() => (
    <GitProviderChooser githubAvailable gitlabAvailable onSelect={onSelect}>
      <div data-existing-connections />
    </GitProviderChooser>
  ));
  expect(ui.container.querySelector("[data-existing-connections]")).not.toBeNull();
  ui.getByText("Add provider").click();
  flush();
  const chooser = ui.container.querySelector("[data-git-provider-chooser]")!;
  expect(chooser.textContent).toContain("GitHub");
  expect(chooser.textContent).toContain("GitLab");
  chooser.querySelector<HTMLButtonElement>("button")!.click();
  flush();
  expect(onSelect).toHaveBeenCalledWith("github");
  expect(ui.container.querySelector("[data-git-provider-chooser]")).toBeNull();
  ui.unmount();
});

it("hides an unavailable GitLab provider and cannot open when no provider is available", () => {
  const onSelect = vi.fn();
  const ui = mountSolid(() => (
    <GitProviderChooser githubAvailable gitlabAvailable={false} onSelect={onSelect}>
      <div />
    </GitProviderChooser>
  ));
  ui.getByText("Add provider").click();
  flush();
  expect(ui.container.querySelector("[data-git-provider-chooser]")?.textContent).not.toContain(
    "GitLab",
  );
  ui.unmount();

  const empty = mountSolid(() => (
    <GitProviderChooser githubAvailable={false} gitlabAvailable={false} onSelect={onSelect}>
      <div />
    </GitProviderChooser>
  ));
  expect(empty.getByText("Add provider").closest("button")?.disabled).toBe(true);
  empty.unmount();
});
