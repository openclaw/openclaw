import { expect, it, onTestFinished, vi } from "vitest";
import type { ProjectsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import {
  answerConfirmDialog,
  installDialogPolyfill,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
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

it("keeps search visible across reopening, routes row typing to it, and matches Unicode", async () => {
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
  expect(view.container.querySelector('input[type="search"]')).not.toBeNull();
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
  const typed = new KeyboardEvent("keydown", {
    key: "C",
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  projectRow.dispatchEvent(typed);
  flush();
  // The key moves focus into the field and stays uncancelled, so the browser types it there.
  expect(document.activeElement).toBe(input);
  expect(typed.defaultPrevented).toBe(false);
  input.value = nfcQuery;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(rows()).toHaveLength(1);
  expect(rows()[0]?.textContent).toContain("Cafe");
  view.unmount();
});

async function removalFixture(scopes = ["operator.admin"]) {
  const fixture = createRepositoryFixture();
  const { request, browser, context } = fixture;
  const saved = {
    id: "saved",
    displayName: "lossless-claw",
    repositoryIdentity: "owner-a/lossless-claw",
    source: "registered" as const,
  };
  const other = { ...saved, id: "other", repositoryIdentity: "owner-b/lossless-claw" };
  const workspace = {
    id: "builtin",
    displayName: "Agent home",
    repoRoot: "/workspace",
    source: "workspace" as const,
  };
  let projects = [saved, other, workspace];
  const removal = createDeferred<{ removed: boolean }>();
  request.mockImplementation(async (method, params) => {
    if (method === "projects.list") {
      return { projects };
    }
    if (method === "projects.remove") {
      await removal.promise;
      projects = projects.filter((project) => project.id !== params!.id);
      return { removed: true };
    }
    return { branches: [] };
  });
  Object.assign(context.gateway.snapshot.hello!, { auth: { role: "operator", scopes } });
  prepareCatalog(fixture, true);
  Object.assign(context.gateway.snapshot.hello!, {
    features: { methods: ["projects.list", "projects.remove"] },
  });
  const restoreDialog = installDialogPolyfill();
  onTestFinished(restoreDialog);
  const view = mountProjectChip(fixture, () => ({
    folder: "",
    workspace: "/home/openclaw/.openclaw/workspace",
    projectId: browser.projectId,
    selectedRemoteProject: browser.remoteProject,
    projects: browser.projects,
    recents: [],
    projectQuery: browser.projectQuery,
  }));
  await waitForSolid(() =>
    expect(view.container.querySelectorAll('[data-value^="project:"]')).toHaveLength(3),
  );
  const openRemoval = async () => {
    view.getByText("Manage projects").click();
    flush();
    const opener = view.container.querySelector<HTMLButtonElement>(
      ".project-picker__remove-button",
    )!;
    opener.focus();
    opener.click();
    flush();
    return opener;
  };
  const confirmRemoval = async () => {
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("projects.remove", {
        id: "saved",
        deleteCheckout: false,
      }),
    );
  };
  return { ...fixture, view, removal, openRemoval, confirmRemoval };
}

it("hides shared catalog management from write-only operators", async () => {
  const { view } = await removalFixture(["operator.write"]);
  expect(view.queryByText("Manage projects")).toBeNull();
  expect(view.container.querySelector(".project-picker__manage")).toBeNull();
  expect(view.queryByText("Add or open a project")).toBeNull();
});

it("uses native confirmation, cancels without RPC, and reconciles the selected project through its owner", async () => {
  const { browser, request, persistPreference, view, removal, openRemoval, confirmRemoval } =
    await removalFixture();
  browser.selectProject({ kind: "local", id: "saved" });
  const opener = await openRemoval();
  expect(view.container.querySelectorAll(".project-picker__remove-button")).toHaveLength(2);
  expect(view.getByText("Done").getAttribute("aria-pressed")).toBe("true");
  expect(view.container.textContent).toContain("owner-a/lossless-claw");
  expect(view.container.textContent).toContain("owner-b/lossless-claw");
  expect(view.container.textContent).toContain("Agent workspace");
  const actions = await waitForConfirmDialogActions();
  expect(document.activeElement?.textContent).toBe("Cancel");
  expect([...actions.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "Cancel",
    "Remove",
  ]);
  expect(document.body.textContent).toContain("Remove lossless-claw?");
  expect(document.body.textContent).toContain(
    "This removes the project from the Gateway catalog for all users and agents. Files, sessions and history are kept.",
  );
  expect(opener.getAttribute("title")).toBe(
    "Remove from the shared catalog; keep files and sessions",
  );
  answerConfirmDialog(actions, "cancel");
  await waitForSolid(() => expect(document.activeElement).toBe(opener));
  expect(request.mock.calls.filter(([method]) => method === "projects.remove")).toHaveLength(0);
  opener.click();
  await confirmRemoval();
  removal.resolve({ removed: true });
  await waitForSolid(() =>
    expect(view.container.querySelector('[data-value="project:saved"]')).toBeNull(),
  );
  expect(browser.projectId).toBe("");
  expect(persistPreference).toHaveBeenCalledWith(
    "",
    "/home/openclaw/.openclaw/workspace",
    expect.objectContaining({ projectId: "", remoteProject: null }),
  );
  expect(view.container.querySelector('[data-value="project:other"]')).not.toBeNull();
});

it.each(["connection epoch", "new selection"] as const)(
  "does not overwrite a newer %s after removing a saved project",
  async (change) => {
    const {
      browser,
      gateway,
      state: place,
      changed,
      request,
      removal,
      openRemoval,
      confirmRemoval,
    } = await removalFixture();
    browser.selectProject({ kind: "local", id: "saved" });
    const fallback = vi.spyOn(place, "applyFolder");
    await openRemoval();
    await confirmRemoval();
    if (change === "connection epoch") {
      Object.assign(gateway, { connectionEpoch: gateway.connectionEpoch + 1 });
    } else {
      browser.selectProject({ kind: "local", id: "other" });
    }
    changed();
    removal.resolve({ removed: true });
    await waitForSolid(() =>
      expect(document.querySelector<HTMLButtonElement>(".project-picker__manage")!.disabled).toBe(
        false,
      ),
    );
    expect(fallback).not.toHaveBeenCalled();
    if (change === "connection epoch") {
      expect(request.mock.calls.filter(([method]) => method === "projects.list")).toHaveLength(1);
      expect(browser.projectId).toBe("saved");
    } else {
      await waitForSolid(() =>
        expect(browser.projects.some((project) => project.id === "saved")).toBe(false),
      );
      expect(browser.projectId).toBe("other");
    }
  },
);

it("re-reads the catalog after removal instead of adopting an in-flight pre-write list", async () => {
  const { browser, request, view, removal, openRemoval, confirmRemoval } = await removalFixture();
  const previousProjects = [...browser.projects];
  const previousRead = createDeferred<ProjectsListResult>();
  request.mockReturnValueOnce(previousRead.promise);
  const refreshing = browser.refreshProjects();
  await openRemoval();
  await confirmRemoval();
  removal.resolve({ removed: true });
  previousRead.resolve({ projects: previousProjects });
  await refreshing;
  await waitForSolid(() =>
    expect(view.container.querySelector('[data-value="project:saved"]')).toBeNull(),
  );
  expect(request.mock.calls.filter(([method]) => method === "projects.list")).toHaveLength(3);
});
