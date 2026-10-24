/* @vitest-environment jsdom */

import { setImmediate as nextTurn } from "node:timers/promises";
import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { pathForClawCatalogEntry } from "../../app-route-paths.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ClawsPage } from "../claws/page.tsx";
import { page as clawsRoute } from "../claws/route.ts";
import {
  cleanupAgentsHomePageTest,
  createPage as basePage,
  setupAgentsHomePageTest,
  workflowOperator,
} from "./agents-home-page.test-helpers.ts";
import type { ClawCatalogEntry } from "./claws-catalog-client.ts";

beforeEach(setupAgentsHomePageTest);
afterEach(cleanupAgentsHomePageTest);

function field(value: unknown, key: string) {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

function controls(container: HTMLElement, fixture: ReturnType<typeof basePage>) {
  const find = <T extends HTMLElement = HTMLElement>(selector: string) =>
    container.querySelector<T>(selector);
  const add = () => find<HTMLButtonElement>("[data-claws-confirm] button");
  const calls = (method: string) => fixture.request.mock.calls.filter(([name]) => name === method);
  return {
    mockRpc: (method: string, respond: (params: unknown, fallback: () => unknown) => unknown) => {
      const original = fixture.request.getMockImplementation()!;
      fixture.request.mockImplementation((name, params, options) => {
        const fallback = () => original(name, params, options);
        return name === method ? respond(params, fallback) : fallback();
      });
    },
    find,
    visible: (selector: string) => waitForSolid(() => expect(find(selector)).not.toBeNull()),
    hidden: (selector: string) => waitForSolid(() => expect(find(selector)).toBeNull()),
    showText: (selector: string, text: string) =>
      waitForSolid(() => expect(find(selector)?.textContent).toContain(text)),
    add,
    calls,
    lastArgs: (method: string) => calls(method).at(-1)?.[1],
    ready: () => waitForSolid(() => expect(add()).toHaveProperty("disabled", false)),
    chat: (pathname?: string) =>
      vi.waitFor(() =>
        expect(fixture.navigate).toHaveBeenCalledWith(
          "chat",
          pathname ? expect.objectContaining({ pathname }) : expect.anything(),
        ),
      ),
    reconnect: () => {
      fixture.setPhase("reconnecting");
      flush();
      fixture.setPhase("connected");
    },
    enter: (query: string) => {
      const search = find<HTMLInputElement>("[data-claws-search]")!;
      search.value = query;
      search.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
    },
  };
}

function createPage(options: Parameters<typeof basePage>[0]) {
  const fixture = basePage(options);
  return { ...fixture, ...controls(fixture.page, fixture) };
}

function createDetail(options: Parameters<typeof createPage>[0] = {}) {
  const fixture = createPage({ clawsEnabled: true, ...options });
  const [location, setLocation] = createSignal({
    pathname: pathForClawCatalogEntry(workflowOperator.packageName, ""),
    search: "",
    hash: "",
  });
  const view = mountSolid(
    () =>
      createComponent(ClawsPage, {
        get routeData() {
          return { location: location(), basePath: "" };
        },
      }),
    { wrapper: fixture.wrapper },
  );
  onTestFinished(view.unmount);
  return {
    ...fixture,
    detail: view.container,
    ...controls(view.container, fixture),
    setPackageName: (packageName: string) =>
      setLocation({ pathname: pathForClawCatalogEntry(packageName, ""), search: "", hash: "" }),
  };
}

describe("Claws discovery", () => {
  it("opens every release file inline without treating help as navigation", async () => {
    const names = ["AGENTS.md", "SOUL.md", "USER.md", "BOOTSTRAP.md", "notes/context.md"];
    const ui = createDetail({ workspaceFileNames: names });
    await ui.visible(".claws-workspace-file__info");
    const section = ui.find(".plugin-capabilities")!;
    expect(section.querySelector("h2 > span")?.textContent).toBe(String(names.length));
    expect(
      [...section.querySelectorAll(".plugin-capability__copy strong")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["SOUL.md", "AGENTS.md", "USER.md", "BOOTSTRAP.md", "notes/context.md"]);
    expect(section.querySelectorAll(".claws-workspace-file__info")).toHaveLength(names.length);
    section.querySelector<HTMLButtonElement>(".claws-workspace-file__info")!.click();
    expect(ui.calls("claws.catalog.preview")).toHaveLength(0);
    section.querySelector<HTMLButtonElement>(".claws-workspace-file__open")!.click();
    await vi.waitFor(() =>
      expect(ui.request).toHaveBeenCalledWith(
        "claws.catalog.preview",
        expect.objectContaining({ name: "SOUL.md" }),
      ),
    );
    const preview = ui.detail.querySelector("openclaw-file-preview-modal")!;
    expect(preview.files.map((file) => file.path)).toEqual(names);
    expect(section.querySelectorAll(".claws-workspace-file__open")).toHaveLength(names.length);
    for (const name of names) {
      preview.dispatchEvent(
        new CustomEvent("file-preview-select", { detail: name, bubbles: true }),
      );
      await vi.waitFor(() =>
        expect(ui.request).toHaveBeenCalledWith(
          "claws.catalog.preview",
          expect.objectContaining({ name }),
        ),
      );
    }
  });

  it("releases a closed preview before transport settles and isolates its replacement", async () => {
    const ui = createDetail();
    await ui.visible(".claws-workspace-file__open");
    const retired = createDeferredCore<unknown>();
    ui.request.mockReturnValueOnce(retired.promise);
    ui.find<HTMLButtonElement>(".claws-workspace-file__open")!.click();
    await waitForSolid(() =>
      expect(ui.detail.querySelector("openclaw-file-preview-modal")).not.toBeNull(),
    );
    const preview = ui.detail.querySelector("openclaw-file-preview-modal")!;
    const readiness = preview.fileRequest();
    expect(readiness).toBeDefined();
    preview.dispatchEvent(new CustomEvent("file-preview-close", { bubbles: true }));
    await readiness;
    await waitForSolid(() =>
      expect(ui.detail.querySelector("openclaw-file-preview-modal")).toBeNull(),
    );

    const replacement = createDeferredCore<unknown>();
    ui.request.mockReturnValueOnce(replacement.promise);
    ui.find<HTMLButtonElement>(".claws-workspace-file__open")!.click();
    await waitForSolid(() =>
      expect(ui.find("openclaw-file-preview-modal .body")?.getAttribute("aria-busy")).toBe("true"),
    );
    retired.resolve({ preview: { kind: "instruction", name: "SOUL.md", content: "Retired" } });
    await nextTurn();
    expect(ui.detail.textContent).not.toContain("Retired");
    replacement.resolve({
      preview: { kind: "instruction", name: "SOUL.md", content: "Current preview" },
    });
    await ui.showText(".detail-body", "Current preview");
  });

  it.each([
    "/claws",
    "/claws/workflow-operator",
    "/claws/packages/%40openclaw%2Fworkflow-operator",
  ])("rejects direct visits to %s while Labs is disabled", async (pathname) => {
    const ui = createPage({ pathname });
    const location = { pathname, search: "", hash: "" };
    const result = await clawsRoute.loader!(ui.context, {
      location,
      signal: new AbortController().signal,
      shouldRun: () => true,
      revalidating: false,
      cause: "navigation",
      deps: clawsRoute.loaderDeps!(ui.context, location),
    });
    expect(result).toEqual({ type: "notFound", data: undefined });
    expect(ui.ensureConfigLoaded).toHaveBeenCalledOnce();
    expect(ui.page.textContent).toContain("Claws is disabled");
    expect(ui.find("[data-claws-explore]")).toBeNull();
    expect(ui.find("[data-claws-confirm]")).toBeNull();
    expect(ui.request.mock.calls.some(([method]) => method.startsWith("claws."))).toBe(false);
  });

  it("removes discovery when the Labs toggle is disabled during a visit", async () => {
    const ui = createPage({ clawsEnabled: true });
    await vi.waitFor(() => expect(ui.page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
    ui.setClawsEnabled(false);
    await ui.hidden("[data-claws-explore]");
    expect(ui.page.textContent).toContain("Claws is disabled");
  });

  it("shows official Claws and opens their dedicated route", async () => {
    const ui = createPage({ clawsEnabled: true });
    await vi.waitFor(() => expect(ui.page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
    expect(ui.find(".hub-page-header h1.page-title")?.textContent).toBe("Claws");
    expect(ui.find(".settings-page [data-claws-search]")).not.toBeNull();
    expect(ui.find(".settings-page .hub-page-header")).toBeNull();
    expect(ui.find(".agents-home__card")).toBeNull();
    expect(ui.page.textContent).not.toContain("Manage agents");
    expect(ui.request.mock.calls.some(([method]) => method === "sessions.list")).toBe(false);

    ui.find<HTMLButtonElement>(".agents-home__claw-card-link")?.click();
    expect(ui.navigate).toHaveBeenCalledWith("claws", {
      pathname: "/claws/packages/%40openclaw%2Fworkflow-operator",
    });
    expect(ui.request).toHaveBeenCalledWith("claws.catalog.search", {
      category: "productivity",
      limit: 8,
    });
  });

  it("updates Explore results when the search changes", async () => {
    const ui = createPage({ clawsEnabled: true });
    await vi.waitFor(() => expect(ui.page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));

    const search = ui.find<HTMLInputElement>("[data-claws-search]");
    expect(search).not.toBeNull();
    ui.enter("missing");
    await vi.waitFor(() => expect(ui.page.querySelectorAll("[data-claws-entry]")).toHaveLength(0));
    await vi.waitFor(() =>
      expect(ui.request).toHaveBeenCalledWith("claws.catalog.search", { query: "missing" }),
    );

    ui.enter("workflow");
    await vi.waitFor(() => expect(ui.page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
  });

  it("retries the selected package's catalog read while retaining its route", async () => {
    const ui = createDetail({
      clawsEnabled: false,
    });
    const pending = createDeferredCore<{ entries: ClawCatalogEntry[] }>();
    const recovered = createDeferredCore<{ entries: ClawCatalogEntry[] }>();
    let attempts = 0;
    ui.mockRpc("claws.catalog.search", (params, fallback) => {
      if (field(params, "limit") === 100) {
        return ++attempts === 1 ? pending.promise : recovered.promise;
      }
      return fallback();
    });
    ui.setClawsEnabled(true);
    await waitForSolid(() => expect(attempts).toBe(1));
    const back = ui.find(".plugin-catalog-detail__back");
    expect(back?.getAttribute("href")).toBe("/claws");
    expect(ui.find(".plugin-catalog-detail--loading")).not.toBeNull();
    expect(ui.find("[data-claws-confirm]")).toBeNull();
    pending.reject(new Error("Catalog temporarily unavailable"));
    await ui.showText("[role=alert]", "Catalog temporarily unavailable");
    ui.find("[role=alert] button")!.click();
    await waitForSolid(() => expect(attempts).toBe(2));
    expect(ui.find("[role=alert]")).toBeNull();
    expect(ui.find(".plugin-catalog-detail__back")).toBe(back);
    expect(ui.find("[data-claws-confirm]")).toBeNull();
    recovered.resolve({ entries: [workflowOperator] });
    await ui.visible(".plugin-capabilities");
    expect(ui.request).toHaveBeenCalledWith("claws.catalog.search", {
      query: workflowOperator.packageName,
      limit: 100,
    });
  });

  it("retires a pending catalog reply when the package route changes", async () => {
    const ui = createDetail({
      clawsEnabled: false,
    });
    const retired = createDeferredCore<{ entries: ClawCatalogEntry[] }>();
    ui.mockRpc("claws.catalog.search", (params, fallback) => {
      if (field(params, "query") === workflowOperator.packageName) {
        return retired.promise;
      }
      return fallback();
    });
    ui.setClawsEnabled(true);
    await waitForSolid(() =>
      expect(ui.request).toHaveBeenCalledWith("claws.catalog.search", {
        query: workflowOperator.packageName,
        limit: 100,
      }),
    );
    ui.setPackageName("@openclaw/missing");
    await ui.visible("[role=alert]");
    const error = ui.find("[role=alert]")?.textContent;
    retired.resolve({ entries: [workflowOperator] });
    await retired.promise;
    await nextTurn();
    flush();
    expect(ui.find("[role=alert]")?.textContent).toBe(error);
    expect(ui.find(".plugin-capabilities")).toBeNull();
    expect(ui.find("[data-claws-confirm]")).toBeNull();
    expect(ui.request.mock.calls.some(([method]) => method === "claws.catalog.detail")).toBe(false);
  });

  it("refreshes a selected Claw after reconnect and ignores the retired catalog reply", async () => {
    const ui = createDetail();
    await ui.visible(".plugin-capabilities");
    const stale = createDeferredCore<{ entries: ClawCatalogEntry[] }>();
    let searches = 0;
    ui.mockRpc("claws.catalog.search", (params, fallback) => {
      if (field(params, "limit") === 100 && ++searches === 1) {
        return stale.promise;
      }
      return fallback();
    });
    ui.reconnect();
    await waitForSolid(() => expect(searches).toBe(1));
    ui.reconnect();
    await waitForSolid(() => expect(ui.calls("claws.catalog.detail")).toHaveLength(2));
    await ui.visible(".plugin-capabilities");
    stale.resolve({ entries: [{ ...workflowOperator, installs: 0, latestVersion: "9.9.9" }] });
    await stale.promise;
    await nextTurn();
    flush();
    expect(ui.calls("claws.catalog.detail")).toHaveLength(2);
    expect(ui.find(".plugin-capabilities")).not.toBeNull();
  });

  it("retries a failed detail read without replacing the shell or admitting Add early", async () => {
    const ui = createDetail();
    await ui.visible(".plugin-capabilities");
    const addButton = ui.add();
    const original = ui.request.getMockImplementation()!;
    const retry = createDeferredCore<unknown>();
    let attempts = 0;
    ui.mockRpc("claws.catalog.detail", () => {
      if (++attempts === 1) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Detail temporarily unavailable",
        });
      }
      return retry.promise;
    });
    ui.reconnect();
    await ui.showText("[role=alert]", "Detail temporarily unavailable");
    expect(ui.find("[role=alert]")?.textContent).not.toContain("INVALID_REQUEST");
    expect(ui.add()).toBe(addButton);
    expect(addButton).toHaveProperty("disabled", true);
    expect(ui.find(".plugin-capabilities")).toBeNull();
    ui.find("[role=alert] button")!.click();
    await ui.visible(".claws-content-skeleton");
    expect(ui.find("[role=alert]")).toBeNull();
    expect(addButton).toHaveProperty("disabled", true);
    retry.resolve(await original("claws.catalog.detail", {}));
    await ui.visible(".plugin-capabilities");
    expect(attempts).toBe(2);
    expect(ui.add()).toBe(addButton);
    expect(addButton).toHaveProperty("disabled", false);
  });

  it("retires pending detail loading immediately on disconnect and ignores its late failure", async () => {
    const ui = createDetail();
    await ui.visible(".plugin-capabilities");
    const stale = createDeferredCore<unknown>();
    let reads = 0;
    ui.mockRpc("claws.catalog.detail", (_params, fallback) => {
      if (++reads === 1) {
        return stale.promise;
      }
      return fallback();
    });
    ui.setPhase("reconnecting");
    flush();
    expect(ui.find(".plugin-capabilities")).not.toBeNull();
    ui.setPhase("connected");
    await ui.visible(".claws-content-skeleton");
    expect(ui.add()).toHaveProperty("disabled", true);
    ui.setPhase("reconnecting");
    await ui.hidden(".claws-content-skeleton");
    expect(ui.find(".plugin-capabilities")).toBeNull();
    expect(ui.add()).toHaveProperty("disabled", true);
    ui.setPhase("connected");
    await ui.visible(".plugin-capabilities");
    stale.reject(new Error("Retired detail failed"));
    await stale.promise.catch(() => {});
    flush();
    expect(reads).toBe(2);
    expect(ui.find("[role=alert]")).toBeNull();
    expect(ui.find(".plugin-capabilities")).not.toBeNull();
    expect(ui.add()).toHaveProperty("disabled", false);
  });

  it("cancels superseded Explore debounce and ignores an older search result", async () => {
    const ui = createPage({ clawsEnabled: true });
    await waitForSolid(() =>
      expect(ui.page.querySelectorAll("[data-claws-entry]")).toHaveLength(1),
    );
    const stale = createDeferredCore<{ entries: (typeof workflowOperator)[] }>();
    ui.mockRpc("claws.catalog.search", (params, fallback) => {
      const query = field(params, "query");
      if (query === "stale") {
        return stale.promise;
      }
      if (query === "fresh") {
        return { entries: [{ ...workflowOperator, displayName: "Fresh result" }] };
      }
      return fallback();
    });
    vi.useFakeTimers();
    ui.enter("cancelled");
    ui.enter("stale");
    expect(ui.page.querySelectorAll(".agents-home__claw-skeleton")).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(149);
    expect(ui.request).not.toHaveBeenCalledWith("claws.catalog.search", { query: "stale" });
    await vi.advanceTimersByTimeAsync(1);
    expect(ui.request).toHaveBeenCalledWith("claws.catalog.search", { query: "stale" });
    expect(ui.request).not.toHaveBeenCalledWith("claws.catalog.search", { query: "cancelled" });

    ui.enter("fresh");
    await vi.advanceTimersByTimeAsync(150);
    await ui.showText("[data-claws-results]", "Fresh result");
    stale.resolve({ entries: [workflowOperator] });
    await stale.promise;
    flush();
    expect(ui.find("[data-claws-results]")?.textContent).toContain("Fresh result");
    expect(ui.find("[data-claws-results]")?.textContent).not.toContain("Workflow Operator");
  });

  it("retries the current Explore query after a failed search", async () => {
    const ui = createPage({ clawsEnabled: true });
    await waitForSolid(() =>
      expect(ui.page.querySelectorAll("[data-claws-entry]")).toHaveLength(1),
    );
    let attempts = 0;
    ui.mockRpc("claws.catalog.search", (params, fallback) => {
      const query = field(params, "query");
      if (query === "retry") {
        if (++attempts === 1) {
          throw new Error("Search temporarily unavailable");
        }
        return { entries: [workflowOperator] };
      }
      return fallback();
    });
    ui.enter("retry");
    await ui.showText("[data-claws-explore] [role=alert]", "Search temporarily unavailable");
    ui.find<HTMLButtonElement>("[data-claws-explore] [role=alert] button")!.click();
    await waitForSolid(() =>
      expect(ui.page.querySelectorAll("[data-claws-results] [data-claws-entry]")).toHaveLength(1),
    );
    expect(attempts).toBe(2);
    expect(ui.find<HTMLInputElement>("[data-claws-search]")?.value).toBe("retry");
    expect(ui.find("[data-claws-explore] [role=alert]")).toBeNull();
  });

  it("admits one Add from same-task clicks and stays busy through its completion", async () => {
    const apply = createDeferredCore();
    const ui = createDetail({
      applyWait: apply.promise,
    });
    await ui.ready();
    expect(ui.request).toHaveBeenCalledWith("claws.catalog.detail", {
      packageName: workflowOperator.packageName,
      version: workflowOperator.latestVersion,
    });
    expect(ui.calls("claws.add.plan")).toHaveLength(0);
    const button = ui.add()!;
    button.click();
    button.click();
    expect(ui.calls("claws.add.apply")).toHaveLength(1);
    expect(ui.request).toHaveBeenCalledWith("claws.add.apply", {
      source: {
        packageName: workflowOperator.packageName,
        version: workflowOperator.latestVersion,
      },
    });
    await waitForSolid(() => {
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.textContent).toContain("Adding");
    });
    button.click();
    expect(ui.calls("claws.add.apply")).toHaveLength(1);
    apply.resolve();
    await ui.chat();
  });

  it("retires disconnected Add presentation without clearing a successor when the old reply lands", async () => {
    const ui = createDetail();
    await ui.ready();
    const oldApply = createDeferredCore();
    const newApply = createDeferredCore();
    let applications = 0;
    ui.mockRpc("claws.add.apply", async (_params, fallback) => {
      await (applications++ === 0 ? oldApply.promise : newApply.promise);
      return fallback();
    });
    ui.add()!.click();
    await waitForSolid(() => expect(ui.add()?.textContent).toContain("Adding"));
    ui.setPhase("reconnecting");
    await waitForSolid(() => expect(ui.add()?.textContent).not.toContain("Adding"));
    ui.setPhase("connected");
    await waitForSolid(() => {
      expect(ui.calls("claws.catalog.detail")).toHaveLength(2);
      expect(ui.find(".plugin-capabilities")).not.toBeNull();
      expect(ui.add()).toHaveProperty("disabled", false);
      expect(ui.add()?.getAttribute("aria-busy")).toBeNull();
    });
    ui.add()!.click();
    expect(applications).toBe(2);
    await waitForSolid(() => expect(ui.add()?.textContent).toContain("Adding"));
    oldApply.resolve();
    await nextTurn();
    flush();
    expect(ui.add()?.getAttribute("aria-busy")).toBe("true");
    expect(ui.add()?.textContent).toContain("Adding");
    expect(ui.navigate).not.toHaveBeenCalledWith("chat", expect.anything());
    newApply.resolve();
    await ui.chat("/chat/workflow-operator-2");
    expect(applications).toBe(2);
  });

  it("retries an acknowledged agent handoff without applying the Claw again", async () => {
    const ui = createDetail();
    await ui.ready();
    let rosterUnavailable = true;
    vi.useFakeTimers({ toFake: ["Date"] });
    ui.mockRpc("agents.list", (_params, fallback) => {
      if (rosterUnavailable) {
        vi.setSystemTime(Date.now() + 15_001);
        throw new Error("Roster unavailable");
      }
      return fallback();
    });
    ui.add()!.click();
    await ui.showText("[role=alert] button", "Open chat");
    expect(ui.calls("claws.add.apply")).toHaveLength(1);
    expect(ui.navigate).not.toHaveBeenCalledWith("chat", expect.anything());
    rosterUnavailable = false;
    ui.find("[role=alert] button")!.click();
    await ui.chat("/chat/workflow-operator");
    expect(ui.calls("claws.add.apply")).toHaveLength(1);
  });

  it("retains the selected Claw on revalidation and clears it when the package changes", async () => {
    const ui = createDetail();

    await ui.showText(".plugin-capabilities", "AGENTS.md");
    const selected = ui.find(".plugin-capabilities");
    const searches = ui.calls("claws.catalog.search");
    ui.setPackageName(workflowOperator.packageName);
    await waitForSolid(() => {
      expect(ui.find(".plugin-capabilities")).toBe(selected);
      expect(ui.calls("claws.catalog.search")).toEqual(searches);
    });
    ui.setPackageName("@openclaw/another-claw");

    await vi.waitFor(() =>
      expect(ui.request).toHaveBeenCalledWith("claws.catalog.search", {
        query: "@openclaw/another-claw",
        limit: 100,
      }),
    );
    await ui.hidden(".plugin-capabilities");
    expect(ui.add()).toBeNull();
  });

  it("retires a pending Add when the package route changes", async () => {
    const apply = createDeferredCore();
    const ui = createDetail({
      applyWait: apply.promise,
    });

    await ui.ready();
    ui.add()?.click();
    await vi.waitFor(() =>
      expect(ui.request.mock.calls.some(([method]) => method === "claws.add.apply")).toBe(true),
    );

    ui.setPackageName("@openclaw/another-claw");
    await ui.hidden(".plugin-capabilities");
    ui.setPackageName(workflowOperator.packageName);
    await ui.ready();
    apply.resolve();
    ui.add()?.click();
    await ui.chat("/chat/workflow-operator-2");
    expect(ui.navigate.mock.calls.filter(([route]) => route === "chat")).toHaveLength(1);
  });

  it("asks before acknowledging a ClawHub trust warning", async () => {
    const ui = createDetail({
      riskConsentRequired: true,
      clawHubTrustWarning: "Review this release before adding it.",
    });

    await ui.ready();
    ui.add()?.click();

    await ui.showText(".claws-trust-warning", "Review this release before adding it.");
    expect(ui.calls("claws.add.apply")).toHaveLength(1);
    expect(
      ui.request.mock.calls.find(([method]) => method === "claws.add.apply")?.[1],
    ).not.toHaveProperty("acknowledgeClawHubRisk");
    expect(ui.navigate).not.toHaveBeenCalledWith("chat", expect.anything());

    ui.find<HTMLButtonElement>(".claws-add-consent__actions .btn")?.click();
    await ui.hidden(".claws-add-consent");
    ui.add()?.click();
    await vi.waitFor(() => expect(ui.calls("claws.add.apply")).toHaveLength(2));
    expect(ui.lastArgs("claws.add.apply")).not.toHaveProperty("acknowledgeClawHubRisk");
    await ui.visible(".claws-trust-warning");

    const apply = createDeferredCore();
    ui.mockRpc("claws.add.apply", async (_params, fallback) => {
      await apply.promise;
      return fallback();
    });
    const confirm = ui.find(".claws-add-consent__actions .btn.primary")!;
    confirm.click();
    confirm.click();
    expect(ui.calls("claws.add.apply")).toHaveLength(3);
    await waitForSolid(() => {
      expect(ui.find(".claws-trust-warning")).toBeNull();
      expect(ui.add()?.getAttribute("aria-busy")).toBe("true");
      expect(ui.add()?.textContent).toContain("Adding");
    });
    apply.resolve();
    await ui.chat();
    expect(ui.lastArgs("claws.add.apply")).toHaveProperty("acknowledgeClawHubRisk", true);
  });

  it.each(["plugin", "skill"] as const)("asks before applying a %s review plan", async (kind) => {
    const ui = createDetail({
      reviewRequiredOnce: kind,
    });

    await ui.ready();
    ui.add()?.click();

    await vi.waitFor(() =>
      expect(ui.find(".claws-add-consent")?.textContent).toContain(
        kind === "plugin" ? "@openclaw/workflow-tools" : "@openclaw/research",
      ),
    );
    if (kind === "plugin") {
      expect(ui.find(".claws-add-consent")?.textContent).toContain("Conversation access: Allowed");
    }
    expect(ui.calls("claws.add.plan")).toHaveLength(1);
    expect(ui.calls("claws.add.apply")).toHaveLength(1);
    expect(ui.navigate).not.toHaveBeenCalledWith("chat", expect.anything());

    ui.find<HTMLButtonElement>(".claws-add-consent__actions .btn.primary")?.click();
    await ui.chat();
    const applyParams = ui.lastArgs("claws.add.apply");
    expect(applyParams).toHaveProperty("planIntegrity", "sha256:reviewed-plan");
    expect(applyParams).not.toHaveProperty("acknowledgeClawHubRisk");
  });

  it("requires both consents when trust and plugin review are needed", async () => {
    const ui = createDetail({
      riskConsentRequired: true,
      reviewRequiredOnce: "plugin",
    });

    await ui.ready();
    ui.add()?.click();
    await ui.visible(".claws-trust-warning");
    ui.find<HTMLButtonElement>(".claws-add-consent__actions .btn.primary")?.click();

    await ui.showText(".claws-add-consent", "@openclaw/workflow-tools");
    expect(ui.calls("claws.add.apply")).toHaveLength(2);
    expect(ui.navigate).not.toHaveBeenCalledWith("chat", expect.anything());

    ui.find<HTMLButtonElement>(".claws-add-consent__actions .btn.primary")?.click();
    await ui.chat();
    const applyParams = ui.lastArgs("claws.add.apply");
    expect(applyParams).toHaveProperty("acknowledgeClawHubRisk", true);
    expect(applyParams).toHaveProperty("planIntegrity", "sha256:reviewed-plan");
  });
});

it.each(["card", "detail"])(
  "shows Claw artwork and falls back on an image error in the %s",
  async (surface) => {
    const clawIconUrl = `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`;
    const options = { clawIconUrl, clawsEnabled: true };
    const container = surface === "card" ? createPage(options).page : createDetail(options).detail;
    const selector = surface === "card" ? ".agents-home__claw-art" : ".plugin-catalog-detail__icon";
    await waitForSolid(() =>
      expect(container.querySelector(`${selector} img`)?.getAttribute("src")).toBe(clawIconUrl),
    );
    const image = container.querySelector(`${selector} img`)!;
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(image.getAttribute("crossorigin")).toBe("anonymous");
    image.dispatchEvent(new Event("error"));
    await waitForSolid(() => expect(container.querySelector(`${selector} img`)).toBeNull());
    expect(container.querySelector(`${selector} svg`)).not.toBeNull();
  },
);
