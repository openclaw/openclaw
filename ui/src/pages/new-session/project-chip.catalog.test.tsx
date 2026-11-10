import { expect, it, onTestFinished, vi } from "vitest";
import type { ProjectsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { focusChatComposerFromKeydown } from "../chat/chat-pane-shared.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { mountProjectChip, openProjectSearch } from "./project-chip.test-support.tsx";

function prepareCatalog(fixture: ReturnType<typeof createRepositoryFixture>, open: boolean) {
  const { browser, state: place, context, gateway } = fixture;
  Object.assign(gateway, {
    connected: true,
    client: context.gateway.snapshot.client,
    connectionEpoch: 1,
  });
  Object.assign(context.gateway.snapshot.hello!, { features: { methods: ["projects.list"] } });
  const popoverOpen = vi.spyOn(browser, "popoverOpen").mockReturnValue(open);
  vi.spyOn(place, "folder", "get").mockReturnValue("");
  vi.spyOn(place, "workspacePath").mockReturnValue("/home/openclaw/.openclaw/workspace");
  vi.spyOn(place, "browseAvailable").mockReturnValue(true);
  vi.spyOn(place, "isAdmin").mockReturnValue(true);
  vi.spyOn(place, "canWrite").mockReturnValue(true);
  vi.spyOn(place, "deviceFolderAvailable", "get").mockReturnValue(false);
  onTestFinished(() => browser.disconnect());
  browser.synchronize();
  return popoverOpen;
}

it("keeps project search live through catalog reads and retires invalidated rows", async () => {
  const fixture = createRepositoryFixture();
  const { browser, changed, request } = fixture;
  const first = createDeferred<ProjectsListResult>();
  const populated = createDeferred<ProjectsListResult>();
  const refreshed = createDeferred<ProjectsListResult>();
  const recovered = createDeferred<ProjectsListResult>();
  const replacement = createDeferred<ProjectsListResult>();
  request
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => populated.promise)
    .mockImplementationOnce(() => refreshed.promise)
    .mockImplementationOnce(() => recovered.promise)
    .mockImplementationOnce(() => replacement.promise);
  const popoverOpen = prepareCatalog(fixture, false);
  let nativeTerminal = false;
  const mountPicker = () =>
    mountProjectChip(
      fixture,
      () => ({
        folder: "",
        workspace: "/home/openclaw/.openclaw/workspace",
        projectId: browser.projectId,
        selectedRemoteProject: browser.remoteProject,
        projects: browser.projects,
        recents: [],
        projectQuery: browser.projectQuery,
      }),
      () => nativeTerminal,
    );
  let view = mountPicker();
  expect(view.container.querySelector('input[type="search"]')).toBeNull();
  popoverOpen.mockReturnValue(true);
  changed();
  await openProjectSearch(view.container);
  let input = view.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  const rows = () =>
    Array.from(view.container.querySelectorAll<HTMLButtonElement>('[data-value^="project:"]'));
  const type = (value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
  };
  input.focus();
  type("alpha");
  popoverOpen.mockReturnValue(false);
  changed();
  await waitForSolid(() =>
    expect(
      view.container
        .querySelector(".new-session-page__project-popover")
        ?.getAttribute("data-phase"),
    ).toBe("hidden"),
  );
  expect(view.container.querySelector('input[type="search"]')).toBe(input);
  popoverOpen.mockReturnValue(true);
  changed();
  await waitForSolid(() =>
    expect(
      view.container
        .querySelector(".new-session-page__project-popover")
        ?.getAttribute("data-phase"),
    ).toBe("open"),
  );
  expect(input.value).toBe("alpha");
  input.focus();
  expect(rows()).toHaveLength(0);
  expect(request).toHaveBeenCalledExactlyOnceWith("projects.list", {});
  const alpha = {
    id: "alpha",
    displayName: "Alpha project",
    repositoryIdentity: "acme-labs/alpha",
    source: "registered" as const,
  };
  const beta = {
    id: "beta",
    displayName: "Beta project",
    repositoryIdentity: "acme-labs/beta",
    source: "registered" as const,
  };
  first.resolve({ projects: [] });
  await waitForSolid(() => expect(view.getByText("No local projects match")).not.toBeNull());
  type("");
  expect(view.getByText("No local projects registered")).not.toBeNull();
  type("alpha");
  const populate = browser.refreshProjects();
  populated.resolve({ projects: [alpha, beta] });
  await populate;
  await waitForSolid(() => expect(rows()).toHaveLength(1));
  const alphaRow = rows()[0];
  expect(alphaRow?.textContent).toContain("Alpha project");
  expect(view.container.querySelector('input[type="search"]')).toBe(input);
  expect(document.activeElement).toBe(input);
  type("");
  expect(rows()).toHaveLength(2);
  type("  ALPHA  ");
  expect(rows()).toEqual([alphaRow]);
  expect(alphaRow?.textContent).toContain("acme-labs/alpha");
  type("acme-labs");
  expect(rows()).toHaveLength(2);
  expect(view.container.querySelector('[data-value="workspace"]')).toBeNull();
  type("/home/openclaw");
  expect(rows()).toHaveLength(0);
  type("acme-labs/beta");
  expect(rows()[0]?.textContent).toContain("Beta project");
  type("worksp");
  expect(view.container.querySelector('[data-value="workspace"]')).not.toBeNull();
  type("alpha");
  expect(rows()).toEqual([alphaRow]);
  const refresh = browser.refreshProjects();
  nativeTerminal = true;
  changed();
  await waitForSolid(() => expect(rows()).toHaveLength(0));
  nativeTerminal = false;
  changed();
  await waitForSolid(() => expect(rows()[0]?.textContent).toContain("Alpha project"));
  expect(view.container.querySelector('input[type="search"]')).toBe(input);
  expect(document.activeElement).toBe(input);
  type("beta");
  expect(rows()[0]?.textContent).toContain("Beta project");
  type("alpha");
  expect(rows()[0]?.textContent).toContain("Alpha project");
  expect(document.activeElement).toBe(input);
  view.unmount();
  view = mountPicker();
  await openProjectSearch(view.container);
  input = view.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  input.focus();
  await waitForSolid(() => expect(rows()[0]?.textContent).toContain("Alpha project"));
  for (const name of ["Beta", "Alpha"]) {
    type(name.toLowerCase());
    await waitForSolid(() => expect(rows()[0]?.textContent).toContain(name + " project"));
  }
  const refreshedAlphaRow = rows()[0];
  refreshed.reject(new Error("Fixture catalog unavailable"));
  await refresh;
  await waitForSolid(() => expect(rows()).toEqual([refreshedAlphaRow]));
  const failure = view.container.querySelector(".new-session-page__project-error");
  expect(failure?.textContent).toContain("Fixture catalog unavailable");
  const retry = failure?.querySelector("button");
  expect(retry?.textContent).toContain("Retry");
  retry?.click();
  recovered.resolve({ projects: [alpha, beta] });
  await waitForSolid(() =>
    expect(view.container.querySelector(".new-session-page__project-error")).toBeNull(),
  );
  expect(rows()).toEqual([refreshedAlphaRow]);
  expect(document.activeElement).toBe(input);
  const replace = browser.refreshProjects(true);
  await waitForSolid(() => expect(rows()).toHaveLength(0));
  expect(input.value).toBe("alpha");
  expect(document.activeElement).toBe(input);
  replacement.resolve({ projects: [beta] });
  await replace;
  await waitForSolid(() => expect(rows()).toHaveLength(0));
  type("beta");
  await waitForSolid(() => expect(rows()[0]?.textContent).toContain("Beta project"));
  expect(view.container.querySelector('[data-value="project:alpha"]')).toBeNull();
  expect(request).toHaveBeenCalledTimes(5);
});

it("keeps automatic search on reopening, respects explicit collapse, and matches Unicode", async () => {
  // The real composer registers its document capture before the lazy picker does.
  const composer = document.body.appendChild(document.createElement("textarea"));
  const redirectToComposer = (event: KeyboardEvent) =>
    focusChatComposerFromKeydown(document.body, event, composer);
  document.addEventListener("keydown", redirectToComposer, true);
  onTestFinished(() => {
    document.removeEventListener("keydown", redirectToComposer, true);
    composer.remove();
  });
  const fixture = createRepositoryFixture();
  const { browser, request, changed } = fixture;
  const loaded = createDeferred<ProjectsListResult>();
  request.mockImplementationOnce(() => loaded.promise);
  const popoverOpen = prepareCatalog(fixture, true);
  const view = mountProjectChip(
    fixture,
    () => ({
      folder: "",
      workspace: "/home/openclaw/.openclaw/workspace",
      projectId: browser.projectId,
      selectedRemoteProject: browser.remoteProject,
      projects: browser.projects,
      recents: [],
      projectQuery: browser.projectQuery,
    }),
    () => false,
  );
  const rows = () =>
    Array.from(view.container.querySelectorAll<HTMLButtonElement>('[data-value^="project:"]'));
  // Stored NFD (e + combining acute); user types NFC (precomposed é).
  const nfdName = "Cafe\u0301";
  const nfcQuery = "Caf\u00e9";
  expect(nfdName).not.toBe(nfcQuery);
  loaded.resolve({
    projects: [
      {
        id: "cafe",
        displayName: nfdName,
        repositoryIdentity: "acme-labs/cafe",
        source: "registered" as const,
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `other-${index}`,
        displayName: `Other ${index}`,
        source: "registered" as const,
      })),
    ],
  });
  await waitForSolid(() => expect(rows()).toHaveLength(6));
  const toggle = () => view.container.querySelector<HTMLButtonElement>(".header-search__toggle")!;
  toggle().click();
  flush();
  expect(view.container.querySelector('input[type="search"]')).toBeNull();
  changed();
  flush();
  expect(view.container.querySelector('input[type="search"]')).toBeNull();
  toggle().click();
  flush();
  popoverOpen.mockReturnValue(false);
  changed();
  await waitForSolid(() =>
    expect(
      view.container
        .querySelector(".new-session-page__project-popover")
        ?.getAttribute("data-phase"),
    ).toBe("hidden"),
  );
  popoverOpen.mockReturnValue(true);
  changed();
  await waitForSolid(() =>
    expect(view.container.querySelector('input[type="search"]')).not.toBeNull(),
  );
  const input = view.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  expect(input).not.toBeNull();
  const projectRow = rows()[0]!;
  projectRow.focus();
  projectRow.dispatchEvent(
    new KeyboardEvent("keydown", { key: "C", bubbles: true, composed: true, cancelable: true }),
  );
  flush();
  expect(input.value).toBe("C");
  expect(document.activeElement).toBe(input);
  input.value = nfcQuery;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(rows()).toHaveLength(1);
  expect(rows()[0]?.textContent).toContain("Cafe");
  view.unmount();
});
