import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import type { ProjectsRegisterResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { mountProjectChip } from "./project-chip.test-support.tsx";

const project: ProjectsRegisterResult = {
  id: "registered-workspace",
  displayName: "Registered workspace",
  repoRoot: "/workspace",
  source: "registered",
};

function mountBrowser() {
  const fixture = createRepositoryFixture();
  const { browser, state: place, context, gateway, request } = fixture;
  Object.assign(gateway, {
    connected: true,
    client: context.gateway.snapshot.client,
    connectionEpoch: 1,
  });
  Object.assign(context.gateway.snapshot.hello!, {
    features: { methods: ["projects.list", "sessions.create"] },
  });
  request.mockImplementation(async (method) =>
    method === "projects.list"
      ? { projects: [] }
      : method === "fs.listDir"
        ? {
            path: "/workspace",
            entries: [{ name: "packages", path: "/workspace/packages" }],
          }
        : { repositoryStatus: "git", branches: [] },
  );
  vi.spyOn(browser, "popoverOpen").mockReturnValue(true);
  vi.spyOn(place, "deviceFolderAvailable", "get").mockReturnValue(false);
  onTestFinished(() => browser.disconnect());
  const view = mountProjectChip(fixture, () => ({
    folder: "",
    workspace: "/workspace",
    projectId: browser.projectId,
    selectedRemoteProject: null,
    projects: browser.projects,
    recents: [],
    projectQuery: "",
  }));
  browser.synchronize();
  const open = async () => {
    browser.selectGatewayBrowser("/workspace");
    await waitForSolid(() => expect(browser.browserProjectPath).toBe("/workspace"));
    await waitForSolid(() =>
      expect(view.queryByRole("button", { name: "Register as project" })).not.toBeNull(),
    );
  };
  const register = () =>
    view.getByRole<HTMLButtonElement>("button", { name: "Register as project" });
  const catalogReads = () =>
    request.mock.calls.filter(([method]) => method === "projects.list").length;
  const expectDisabled = (disabled: boolean) => {
    expect(register().disabled).toBe(disabled);
    expect(
      view.container.querySelector<HTMLButtonElement>(".new-session-page__browser-use")!.disabled,
    ).toBe(disabled);
  };
  return { ...fixture, view, open, register, catalogReads, expectDisabled };
}

describe("project registration presentation", () => {
  it("disables registration and folder selection during the write, then shows failure and permits retry", async () => {
    const { browser, request, view, open, register, expectDisabled } = mountBrowser();
    await open();
    const registration = createDeferred<ProjectsRegisterResult>();
    request.mockImplementationOnce(() => registration.promise);
    const button = register();
    button.click();
    await waitForSolid(() => expectDisabled(true));
    button.click();
    expect(request.mock.calls.filter(([method]) => method === "projects.register")).toHaveLength(1);
    const input = view.getByRole<HTMLInputElement>("combobox");
    input.focus();
    await page.getByRole("combobox").fill("/workspace/no");
    await waitForSolid(() => {
      expect(input.value).toBe("/workspace/no");
      expect(view.queryByRole("option")).toBeNull();
    });
    expect(document.activeElement).toBe(input);
    await page.getByRole("combobox").fill("/workspace");
    await waitForSolid(() => expect(view.getByRole("option").textContent).toContain("packages"));
    registration.reject(new Error("Project registry unavailable"));
    await waitForSolid(() => {
      expect(view.container.textContent).toContain("Project registry unavailable");
      expectDisabled(false);
    });
    const retry = createDeferred<ProjectsRegisterResult>();
    request.mockImplementationOnce(() => retry.promise);
    button.click();
    await waitForSolid(() => expect(button.disabled).toBe(true));
    request.mockImplementationOnce(async () => ({ projects: [project] }));
    retry.resolve(project);
    await waitForSolid(() => {
      expect(browser.browserOpen).toBe(false);
      expect(view.getByRole("button", { name: "Registered workspace" })).not.toBeNull();
    });
  });

  it("releases saving when closed during the post-registration catalog refresh", async () => {
    const { browser, request, open, register, catalogReads, expectDisabled } = mountBrowser();
    await open();
    const catalog = createDeferred<{ projects: ProjectsRegisterResult[] }>();
    const reads = catalogReads();
    request.mockImplementationOnce(async () => project);
    request.mockImplementationOnce(() => catalog.promise);
    register().click();
    await waitForSolid(() => {
      expect(catalogReads()).toBe(reads + 1);
      expect(register().disabled).toBe(true);
    });

    browser.close();
    await open();
    await waitForSolid(() => expectDisabled(false));
    catalog.resolve({ projects: [project] });
    await waitForSolid(() =>
      expect(browser.projects.some((row) => row.id === project.id)).toBe(true),
    );
    expect(browser.browserOpen).toBe(true);
    expect(register().disabled).toBe(false);
  });

  it.each(["close", "disconnect", "connection epoch"])(
    "retires saving on %s and ignores a late failure during a new registration",
    async (retirement) => {
      const { browser, gateway, changed, request, view, open, register } = mountBrowser();
      await open();
      const previous = createDeferred<ProjectsRegisterResult>();
      request.mockImplementationOnce(() => previous.promise);
      register().click();
      await waitForSolid(() => expect(browser.browserRegistering).toBe(true));
      if (retirement === "close") {
        browser.close();
      } else if (retirement === "disconnect") {
        browser.disconnect();
        changed();
      } else {
        Object.assign(gateway, { connectionEpoch: gateway.connectionEpoch + 1 });
        browser.synchronize();
        changed();
      }
      await open();
      const button = register();
      await waitForSolid(() => expect(button.disabled).toBe(false));
      const current = createDeferred<ProjectsRegisterResult>();
      request.mockImplementationOnce(() => current.promise);
      button.click();
      await waitForSolid(() => expect(button.disabled).toBe(true));
      previous.reject(new Error("Retired registration failed"));
      await previous.promise.catch(() => undefined);
      await waitForSolid(() => {
        expect(button.disabled).toBe(true);
        expect(browser.browser.error).toBeNull();
        expect(view.container.textContent).not.toContain("Retired registration failed");
      });
      current.reject(new Error("Current registration failed"));
      await waitForSolid(() => {
        expect(button.disabled).toBe(false);
        expect(view.container.textContent).toContain("Current registration failed");
      });
    },
  );
});
