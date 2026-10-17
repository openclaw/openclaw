/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { PlaceBrowserState } from "./place-browser-state.ts";
import { resolveProjectChip, type ProjectChipOptions } from "./project-chip.ts";
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
  const view = mountSolid(() => <WhereChip params={current()} />);
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
  const params: ProjectChipOptions = {
    state: resolveProjectChip({
      folder: "",
      workspace: "/fixture",
      projectId: "",
      selectedRemoteProject: null,
      projects,
      recents: [],
      projectQuery: "Sample",
    }),
    browseAvailable: true,
    isAdmin: true,
    canWrite: true,
    folder: "",
    workspace: "/fixture",
    projects,
    projectQuery: "Sample",
    projectSearchAvailable: false,
    projectAddAvailable: false,
    remoteProjects: [],
    selectedRemoteProject: null,
    projectSearchCredentialMissing: false,
    projectSearchLoading: false,
    projectSearchError: null,
    projectId: "",
    browserLabel: "Gateway",
    submitting: false,
    pendingPlacement: false,
    popoverOpen: true,
    browserOpen: false,
    browser: new PlaceBrowserState(vi.fn(), vi.fn()),
    registerProjectPath: null,
    registeringProject: false,
    onPopoverShow: vi.fn(),
    onPopoverHide: vi.fn(),
    onPopoverAfterHide: vi.fn(),
    onSelectProject: vi.fn(),
    onProjectQueryInput: vi.fn(),
    onSelectRemoteProject: vi.fn(),
    onApplyFolder: vi.fn(),
    onBrowse: vi.fn(),
    onBrowserBack: vi.fn(),
    onRegisterProject: vi.fn(),
    onClose: vi.fn(),
  };
  const [current, setCurrent] = createSignal(params);
  const view = mountSolid(() => <ProjectChip params={current()} />);
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
  params.projectId = "sample";
  setCurrent({ ...params });
  flush();
  expect(view.container.querySelector('[data-value="project:sample"]')).toBe(row);
  expect(row.textContent).toContain("Sample Project refreshed");
  expect(row.getAttribute("aria-pressed")).toBe("true");
});
