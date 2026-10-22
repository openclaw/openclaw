/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { placementControls } from "./placement.test-support.ts";
import { resolveProjectChip } from "./project-chip.ts";
import { ProjectChip } from "./project-chip.tsx";
import { pickerParams } from "./where-chip.test-support.ts";
import { WhereChip } from "./where-chip.tsx";

it("retains environment heading and device artwork through unrelated refreshes", () => {
  const params = pickerParams(
    true,
    undefined,
    { cloudProfiles: [] },
    { environmentQuery: "Build" },
  );
  const [current, setCurrent] = createSignal(params);
  const view = mountSolid(() => <WhereChip {...current()} />);
  const list = view.container.querySelector(".new-session-page__environment-list")!;
  const row = list.querySelector('[data-value="device:runner"]')!;
  const heading = list.querySelector(".new-session-page__environment-heading");
  const icon = row.querySelector(".session-menu__icon svg");
  const observer = new MutationObserver(() => {});
  observer.observe(list, { subtree: true, childList: true });
  onTestFinished(() => observer.disconnect());
  setCurrent({ ...params });
  flush();
  expect(observer.takeRecords()).toHaveLength(0);
  expect(list.querySelector(".new-session-page__environment-heading")).toBe(heading);
  expect(row.querySelector(".session-menu__icon svg")).toBe(icon);

  const refreshed = { ...params.state.devices[0]!, label: "Build MacBook Pro", platform: "darwin" };
  setCurrent({
    ...params,
    state: {
      ...params.state,
      devices: params.state.devices.map((device) =>
        device.deviceId === "runner" ? refreshed : device,
      ),
    },
  });
  flush();
  expect(list.querySelector('[data-value="device:runner"]')).toBe(row);
  expect(row.textContent).toContain("Build MacBook Pro");
  expect(row.querySelector('[data-form="laptop"]')).not.toBeNull();
});

it("retains project artwork while current labels and selection remain live", () => {
  const projects = [
    {
      id: "sample",
      displayName: "Sample Project",
      repoRoot: "/fixture/sample",
      source: "registered" as const,
    },
  ];
  const { state: place, browser, gateway } = createRepositoryFixture();
  let projectId = "";
  vi.spyOn(place, "folder", "get").mockReturnValue("");
  vi.spyOn(place, "workspacePath").mockReturnValue("/fixture");
  vi.spyOn(place, "browseAvailable").mockReturnValue(true);
  vi.spyOn(place, "isAdmin").mockReturnValue(true);
  vi.spyOn(place, "canWrite").mockReturnValue(true);
  vi.spyOn(place, "deviceFolderAvailable", "get").mockReturnValue(false);
  vi.spyOn(browser, "projects", "get").mockReturnValue(projects);
  vi.spyOn(browser, "projectsReady", "get").mockReturnValue(true);
  vi.spyOn(browser, "projectQuery", "get").mockReturnValue("Sample");
  vi.spyOn(browser, "projectId", "get").mockImplementation(() => projectId);
  vi.spyOn(browser, "popoverOpen").mockReturnValue(true);
  vi.spyOn(browser, "popoverCallbacks").mockReturnValue({
    popoverOpen: true,
    onPopoverShow: vi.fn(),
    onPopoverHide: vi.fn(),
    onPopoverAfterHide: vi.fn(),
  });
  const options = placementControls({ place, gateway, context: undefined });
  const params = {
    params: options,
    state: resolveProjectChip({
      folder: "",
      workspace: "/fixture",
      projectId: "",
      selectedRemoteProject: null,
      projects,
      recents: [],
      projectQuery: "Sample",
    }),
    nativeTerminal: false,
  };
  const [current, setCurrent] = createSignal(params);
  const view = mountSolid(() => <ProjectChip {...current()} />);
  const row = view.container.querySelector('[data-value="project:sample"]')!;
  const icon = row.querySelector(".session-menu__icon svg");
  const observer = new MutationObserver(() => {});
  observer.observe(row, { childList: true, subtree: true });
  onTestFinished(() => observer.disconnect());
  setCurrent({ ...params });
  flush();
  expect(observer.takeRecords()).toHaveLength(0);
  expect(row.querySelector(".session-menu__icon svg")).toBe(icon);
  projects[0]!.displayName = "Sample Project refreshed";
  projectId = "sample";
  setCurrent({ ...params, params: { ...options } });
  flush();
  expect(view.container.querySelector('[data-value="project:sample"]')).toBe(row);
  expect(row.textContent).toContain("Sample Project refreshed");
  expect(row.getAttribute("aria-pressed")).toBe("true");
});
