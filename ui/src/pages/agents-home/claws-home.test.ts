/* @vitest-environment jsdom */

import { setImmediate as nextTurn } from "node:timers/promises";
import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import { pathForClawCatalogEntry } from "../../app-route-paths.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ClawsPage } from "../claws/page.tsx";
import { page as clawsRoute } from "../claws/route.ts";
import {
  cleanupAgentsHomePageTest,
  createPage,
  setupAgentsHomePageTest,
  workflowOperator,
} from "./agents-home-page.test-helpers.ts";
import type { ClawCatalogEntry } from "./claws-catalog-client.ts";

beforeEach(setupAgentsHomePageTest);
afterEach(cleanupAgentsHomePageTest);

function createDetail(options: Parameters<typeof createPage>[0]) {
  const fixture = createPage(options);
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
    find: (selector: string) => view.container.querySelector<HTMLElement>(selector),
    setPackageName: (packageName: string) =>
      setLocation({ pathname: pathForClawCatalogEntry(packageName, ""), search: "", hash: "" }),
  };
}

describe("Claws discovery", () => {
  it.each([
    {
      names: ["AGENTS.md", "SOUL.md", "USER.md", "notes/context.md"],
      ordered: ["SOUL.md", "AGENTS.md", "USER.md", "notes/context.md"],
    },
    { names: ["USER.md", "notes/context.md"], ordered: ["USER.md", "notes/context.md"] },
    { names: ["IDENTITY.md"], ordered: ["IDENTITY.md"] },
  ])("lists every release file inline for $names", async ({ names, ordered }) => {
    const { detail } = createDetail({ clawsEnabled: true, workspaceFileNames: names });
    await vi.waitFor(() => expect(detail.querySelector(".plugin-capabilities")).not.toBeNull());
    const section = detail.querySelector(".plugin-capabilities")!;
    expect(section.querySelector("h2 > span")?.textContent).toBe(String(names.length));
    const titles = [...section.querySelectorAll(".plugin-capability__copy strong")].map(
      (node) => node.textContent,
    );
    expect(titles).toEqual(ordered);
    expect(section.querySelectorAll(".claws-workspace-file__info")).toHaveLength(names.length);
  });

  it("opens every release file inline without treating help as navigation", async () => {
    const names = ["AGENTS.md", "SOUL.md", "USER.md", "BOOTSTRAP.md", "notes/context.md"];
    const { detail, request } = createDetail({ clawsEnabled: true, workspaceFileNames: names });
    await vi.waitFor(() =>
      expect(detail.querySelector(".claws-workspace-file__info")).not.toBeNull(),
    );
    const section = detail.querySelector(".plugin-capabilities")!;
    section.querySelector<HTMLButtonElement>(".claws-workspace-file__info")!.click();
    expect(
      request.mock.calls.filter(([method]) => method === "claws.catalog.preview"),
    ).toHaveLength(0);
    section.querySelector<HTMLButtonElement>(".claws-workspace-file__open")!.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "claws.catalog.preview",
        expect.objectContaining({ name: "SOUL.md" }),
      ),
    );
    const preview = detail.querySelector("openclaw-file-preview-modal")!;
    expect(preview.files.map((file) => file.path)).toEqual(names);
    expect(section.querySelectorAll(".claws-workspace-file__open")).toHaveLength(names.length);
    for (const name of names) {
      preview.dispatchEvent(
        new CustomEvent("file-preview-select", { detail: name, bubbles: true }),
      );
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "claws.catalog.preview",
          expect.objectContaining({ name }),
        ),
      );
    }
  });

  it("releases a closed preview before transport settles and isolates its replacement", async () => {
    const { detail, request } = createDetail({ clawsEnabled: true });
    await waitForSolid(() =>
      expect(detail.querySelector(".claws-workspace-file__open")).not.toBeNull(),
    );
    const retired = createDeferredCore<unknown>();
    request.mockReturnValueOnce(retired.promise);
    detail.querySelector<HTMLButtonElement>(".claws-workspace-file__open")!.click();
    await waitForSolid(() =>
      expect(detail.querySelector("openclaw-file-preview-modal")).not.toBeNull(),
    );
    const preview = detail.querySelector("openclaw-file-preview-modal")!;
    const readiness = preview.fileRequest();
    expect(readiness).toBeDefined();
    preview.dispatchEvent(new CustomEvent("file-preview-close", { bubbles: true }));
    await readiness;
    await waitForSolid(() =>
      expect(detail.querySelector("openclaw-file-preview-modal")).toBeNull(),
    );

    const replacement = createDeferredCore<unknown>();
    request.mockReturnValueOnce(replacement.promise);
    detail.querySelector<HTMLButtonElement>(".claws-workspace-file__open")!.click();
    await waitForSolid(() =>
      expect(
        detail.querySelector("openclaw-file-preview-modal .body")?.getAttribute("aria-busy"),
      ).toBe("true"),
    );
    retired.resolve({ preview: { kind: "instruction", name: "SOUL.md", content: "Retired" } });
    await nextTurn();
    expect(detail.textContent).not.toContain("Retired");
    replacement.resolve({
      preview: { kind: "instruction", name: "SOUL.md", content: "Current preview" },
    });
    await waitForSolid(() =>
      expect(detail.querySelector(".detail-body")?.textContent).toContain("Current preview"),
    );
  });

  it.each([
    "/claws",
    "/claws/workflow-operator",
    "/claws/packages/%40openclaw%2Fworkflow-operator",
  ])("rejects direct visits to %s while Labs is disabled", async (pathname) => {
    const { context, page, request, ensureConfigLoaded } = createPage({ pathname });
    const location = { pathname, search: "", hash: "" };
    const result = await clawsRoute.loader!(
      context,
      createRouteLoaderOptions(location, clawsRoute.loaderDeps!(context, location)),
    );
    expect(result).toEqual({ type: "notFound", data: undefined });
    expect(ensureConfigLoaded).toHaveBeenCalledOnce();
    expect(page.textContent).toContain("Claws is disabled");
    expect(page.querySelector("[data-claws-explore]")).toBeNull();
    expect(page.querySelector("[data-claws-confirm]")).toBeNull();
    expect(request.mock.calls.some(([method]) => method.startsWith("claws."))).toBe(false);
  });

  it("removes discovery when the Labs toggle is disabled during a visit", async () => {
    const { page, setClawsEnabled } = createPage({ clawsEnabled: true });
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
    setClawsEnabled(false);
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).toBeNull());
    expect(page.textContent).toContain("Claws is disabled");
  });

  it("shows official Claws and opens their dedicated route", async () => {
    const { page, navigate, request } = createPage({ clawsEnabled: true });
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
    expect(page.querySelector(".hub-page-header h1.page-title")?.textContent).toBe("Claws");
    expect(page.querySelector(".settings-page [data-claws-search]")).not.toBeNull();
    expect(page.querySelector(".settings-page .hub-page-header")).toBeNull();
    expect(page.querySelector(".agents-home__card")).toBeNull();
    expect(page.textContent).not.toContain("Manage agents");
    expect(request.mock.calls.some(([method]) => method === "sessions.list")).toBe(false);

    page.querySelector<HTMLButtonElement>(".agents-home__claw-card-link")?.click();
    expect(navigate).toHaveBeenCalledWith("claws", {
      pathname: "/claws/packages/%40openclaw%2Fworkflow-operator",
    });
    expect(request).toHaveBeenCalledWith("claws.catalog.search", {
      category: "productivity",
      limit: 8,
    });
  });

  it("updates Explore results when the search changes", async () => {
    const { page, request } = createPage({ clawsEnabled: true });
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));

    const search = page.querySelector<HTMLInputElement>("[data-claws-search]");
    expect(search).not.toBeNull();
    search!.value = "missing";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(0));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.catalog.search", { query: "missing" }),
    );

    search!.value = "workflow";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
  });

  it("retries the selected package's catalog read while retaining its route", async () => {
    const { request, setClawsEnabled, find } = createDetail({ clawsEnabled: false });
    const original = request.getMockImplementation()!;
    const pending = createDeferredCore<{ entries: ClawCatalogEntry[] }>();
    const recovered = createDeferredCore<{ entries: ClawCatalogEntry[] }>();
    let attempts = 0;
    request.mockImplementation((method, params, options) => {
      if (
        method === "claws.catalog.search" &&
        params &&
        typeof params === "object" &&
        Reflect.get(params, "limit") === 100
      ) {
        return ++attempts === 1 ? pending.promise : recovered.promise;
      }
      return original(method, params, options);
    });
    setClawsEnabled(true);
    await waitForSolid(() => expect(attempts).toBe(1));
    const back = find(".plugin-catalog-detail__back");
    expect(back?.getAttribute("href")).toBe("/claws");
    expect(find(".plugin-catalog-detail--loading")).not.toBeNull();
    expect(find("[data-claws-confirm]")).toBeNull();
    pending.reject(new Error("Catalog temporarily unavailable"));
    await waitForSolid(() =>
      expect(find("[role=alert]")?.textContent).toContain("Catalog temporarily unavailable"),
    );
    find("[role=alert] button")!.click();
    await waitForSolid(() => expect(attempts).toBe(2));
    expect(find("[role=alert]")).toBeNull();
    expect(find(".plugin-catalog-detail__back")).toBe(back);
    expect(find("[data-claws-confirm]")).toBeNull();
    recovered.resolve({ entries: [workflowOperator] });
    await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
    expect(request).toHaveBeenCalledWith("claws.catalog.search", {
      query: workflowOperator.packageName,
      limit: 100,
    });
  });

  it("retires a pending catalog reply when the package route changes", async () => {
    const { request, setClawsEnabled, setPackageName, find } = createDetail({
      clawsEnabled: false,
    });
    const original = request.getMockImplementation()!;
    const retired = createDeferredCore<{ entries: ClawCatalogEntry[] }>();
    request.mockImplementation((method, params, options) => {
      if (
        method === "claws.catalog.search" &&
        params &&
        typeof params === "object" &&
        Reflect.get(params, "query") === workflowOperator.packageName
      ) {
        return retired.promise;
      }
      return original(method, params, options);
    });
    setClawsEnabled(true);
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("claws.catalog.search", {
        query: workflowOperator.packageName,
        limit: 100,
      }),
    );
    setPackageName("@openclaw/missing");
    await waitForSolid(() => expect(find("[role=alert]")).not.toBeNull());
    const error = find("[role=alert]")?.textContent;
    retired.resolve({ entries: [workflowOperator] });
    await retired.promise;
    await nextTurn();
    flush();
    expect(find("[role=alert]")?.textContent).toBe(error);
    expect(find(".plugin-capabilities")).toBeNull();
    expect(find("[data-claws-confirm]")).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "claws.catalog.detail")).toBe(false);
  });

  it("refreshes a selected Claw after reconnect and ignores the retired catalog reply", async () => {
    const { request, setPhase, find } = createDetail({ clawsEnabled: true });
    await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
    const original = request.getMockImplementation()!;
    const stale = createDeferredCore<{ entries: ClawCatalogEntry[] }>();
    let searches = 0;
    request.mockImplementation((method, params, options) => {
      if (
        method === "claws.catalog.search" &&
        params &&
        typeof params === "object" &&
        Reflect.get(params, "limit") === 100 &&
        ++searches === 1
      ) {
        return stale.promise;
      }
      return original(method, params, options);
    });
    setPhase("reconnecting");
    flush();
    setPhase("connected");
    await waitForSolid(() => expect(searches).toBe(1));
    setPhase("reconnecting");
    flush();
    setPhase("connected");
    await waitForSolid(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "claws.catalog.detail"),
      ).toHaveLength(2),
    );
    await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
    stale.resolve({ entries: [{ ...workflowOperator, installs: 0, latestVersion: "9.9.9" }] });
    await stale.promise;
    await nextTurn();
    flush();
    expect(request.mock.calls.filter(([method]) => method === "claws.catalog.detail")).toHaveLength(
      2,
    );
    expect(find(".plugin-capabilities")).not.toBeNull();
  });

  it("retries a failed detail read without replacing the shell or admitting Add early", async () => {
    const { request, setPhase, find } = createDetail({ clawsEnabled: true });
    await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
    const addButton = find("[data-claws-confirm] button");
    const original = request.getMockImplementation()!;
    const retry = createDeferredCore<unknown>();
    let attempts = 0;
    request.mockImplementation((method, params, options) => {
      if (method === "claws.catalog.detail") {
        if (++attempts === 1) {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Detail temporarily unavailable",
          });
        }
        return retry.promise;
      }
      return original(method, params, options);
    });
    setPhase("reconnecting");
    flush();
    setPhase("connected");
    await waitForSolid(() =>
      expect(find("[role=alert]")?.textContent).toContain("Detail temporarily unavailable"),
    );
    expect(find("[role=alert]")?.textContent).not.toContain("INVALID_REQUEST");
    expect(find("[data-claws-confirm] button")).toBe(addButton);
    expect(addButton).toHaveProperty("disabled", true);
    expect(find(".plugin-capabilities")).toBeNull();
    find("[role=alert] button")!.click();
    await waitForSolid(() => expect(find(".claws-content-skeleton")).not.toBeNull());
    expect(find("[role=alert]")).toBeNull();
    expect(addButton).toHaveProperty("disabled", true);
    retry.resolve(await original("claws.catalog.detail", {}));
    await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
    expect(attempts).toBe(2);
    expect(find("[data-claws-confirm] button")).toBe(addButton);
    expect(addButton).toHaveProperty("disabled", false);
  });

  it("retires pending detail loading immediately on disconnect and ignores its late failure", async () => {
    const { request, setPhase, find } = createDetail({ clawsEnabled: true });
    await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
    const original = request.getMockImplementation()!;
    const stale = createDeferredCore<unknown>();
    let reads = 0;
    request.mockImplementation((method, params, options) => {
      if (method === "claws.catalog.detail" && ++reads === 1) {
        return stale.promise;
      }
      return original(method, params, options);
    });
    setPhase("reconnecting");
    flush();
    expect(find(".plugin-capabilities")).not.toBeNull();
    setPhase("connected");
    await waitForSolid(() => expect(find(".claws-content-skeleton")).not.toBeNull());
    expect(find("[data-claws-confirm] button")).toHaveProperty("disabled", true);
    setPhase("reconnecting");
    await waitForSolid(() => expect(find(".claws-content-skeleton")).toBeNull());
    expect(find(".plugin-capabilities")).toBeNull();
    expect(find("[data-claws-confirm] button")).toHaveProperty("disabled", true);
    setPhase("connected");
    await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
    stale.reject(new Error("Retired detail failed"));
    await stale.promise.catch(() => {});
    flush();
    expect(reads).toBe(2);
    expect(find("[role=alert]")).toBeNull();
    expect(find(".plugin-capabilities")).not.toBeNull();
    expect(find("[data-claws-confirm] button")).toHaveProperty("disabled", false);
  });

  it("cancels superseded Explore debounce and ignores an older search result", async () => {
    const { page, request } = createPage({ clawsEnabled: true });
    await waitForSolid(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
    const original = request.getMockImplementation()!;
    const stale = createDeferredCore<{ entries: (typeof workflowOperator)[] }>();
    request.mockImplementation((method, params, options) => {
      if (method === "claws.catalog.search") {
        const query =
          params && typeof params === "object" ? Reflect.get(params, "query") : undefined;
        if (query === "stale") {
          return stale.promise;
        }
        if (query === "fresh") {
          return { entries: [{ ...workflowOperator, displayName: "Fresh result" }] };
        }
      }
      return original(method, params, options);
    });
    vi.useFakeTimers();
    const search = page.querySelector<HTMLInputElement>(
      "[data-claws-explore] [data-claws-search]",
    )!;
    const enter = (query: string) => {
      search.value = query;
      search.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
    };
    enter("cancelled");
    enter("stale");
    expect(page.querySelectorAll(".agents-home__claw-skeleton")).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(149);
    expect(request).not.toHaveBeenCalledWith("claws.catalog.search", { query: "stale" });
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledWith("claws.catalog.search", { query: "stale" });
    expect(request).not.toHaveBeenCalledWith("claws.catalog.search", { query: "cancelled" });

    enter("fresh");
    await vi.advanceTimersByTimeAsync(150);
    await waitForSolid(() =>
      expect(page.querySelector("[data-claws-results]")?.textContent).toContain("Fresh result"),
    );
    stale.resolve({ entries: [workflowOperator] });
    await stale.promise;
    flush();
    expect(page.querySelector("[data-claws-results]")?.textContent).toContain("Fresh result");
    expect(page.querySelector("[data-claws-results]")?.textContent).not.toContain(
      "Workflow Operator",
    );
  });

  it("retries the current Explore query after a failed search", async () => {
    const { page, request } = createPage({ clawsEnabled: true });
    await waitForSolid(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
    const original = request.getMockImplementation()!;
    let attempts = 0;
    request.mockImplementation((method, params, options) => {
      const query = params && typeof params === "object" ? Reflect.get(params, "query") : undefined;
      if (method === "claws.catalog.search" && query === "retry") {
        if (++attempts === 1) {
          throw new Error("Search temporarily unavailable");
        }
        return { entries: [workflowOperator] };
      }
      return original(method, params, options);
    });
    const search = page.querySelector<HTMLInputElement>(
      "[data-claws-explore] [data-claws-search]",
    )!;
    search.value = "retry";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForSolid(() =>
      expect(page.querySelector("[data-claws-explore] [role=alert]")?.textContent).toContain(
        "Search temporarily unavailable",
      ),
    );
    page.querySelector<HTMLButtonElement>("[data-claws-explore] [role=alert] button")!.click();
    await waitForSolid(() =>
      expect(page.querySelectorAll("[data-claws-results] [data-claws-entry]")).toHaveLength(1),
    );
    expect(attempts).toBe(2);
    expect(search.value).toBe("retry");
    expect(page.querySelector("[data-claws-explore] [role=alert]")).toBeNull();
  });

  it("reads contents before Add and opens the newly added agent chat", async () => {
    const { detail, request, navigate } = createDetail({ clawsEnabled: true });

    await vi.waitFor(() => expect(detail.querySelector(".plugin-capabilities")).not.toBeNull());
    expect(request).toHaveBeenCalledWith("claws.catalog.detail", {
      packageName: workflowOperator.packageName,
      version: workflowOperator.latestVersion,
    });
    expect(request.mock.calls.some(([method]) => method === "claws.add.plan")).toBe(false);

    await vi.waitFor(() =>
      expect(detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.disabled).toBe(
        false,
      ),
    );
    detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("chat", expect.anything()));
    expect(request).toHaveBeenCalledWith("claws.add.apply", {
      source: {
        packageName: workflowOperator.packageName,
        version: workflowOperator.latestVersion,
      },
    });
  });

  it("admits one Add from same-task clicks and stays busy through its completion", async () => {
    const apply = createDeferredCore();
    const { find, request, navigate } = createDetail({
      clawsEnabled: true,
      applyWait: apply.promise,
    });
    await waitForSolid(() =>
      expect(find("[data-claws-confirm] button")).toHaveProperty("disabled", false),
    );
    const button = find("[data-claws-confirm] button")!;
    button.click();
    button.click();
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    await waitForSolid(() => {
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.textContent).toContain("Adding");
    });
    button.click();
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    apply.resolve();
    await waitForSolid(() => expect(navigate).toHaveBeenCalledWith("chat", expect.anything()));
  });

  it("clears confirmed risk consent while the admitted Add remains busy", async () => {
    const { find, request, navigate } = createDetail({
      clawsEnabled: true,
      riskConsentRequired: true,
    });
    await waitForSolid(() =>
      expect(find("[data-claws-confirm] button")).toHaveProperty("disabled", false),
    );
    find("[data-claws-confirm] button")!.click();
    await waitForSolid(() => expect(find(".claws-trust-warning")).not.toBeNull());
    const original = request.getMockImplementation()!;
    const apply = createDeferredCore();
    request.mockImplementation(async (method, params, options) => {
      if (method === "claws.add.apply") {
        await apply.promise;
      }
      return original(method, params, options);
    });
    const confirm = find(".claws-add-consent__actions .btn.primary")!;
    confirm.click();
    confirm.click();
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(2);
    expect(
      request.mock.calls.findLast(([method]) => method === "claws.add.apply")?.[1],
    ).toHaveProperty("acknowledgeClawHubRisk", true);
    await waitForSolid(() => {
      expect(find(".claws-trust-warning")).toBeNull();
      expect(find("[data-claws-confirm] button")?.getAttribute("aria-busy")).toBe("true");
      expect(find("[data-claws-confirm] button")?.textContent).toContain("Adding");
    });
    apply.resolve();
    await waitForSolid(() => expect(navigate).toHaveBeenCalledWith("chat", expect.anything()));
  });

  it("retires disconnected Add presentation without clearing a successor when the old reply lands", async () => {
    const { find, request, navigate, setPhase } = createDetail({ clawsEnabled: true });
    await waitForSolid(() =>
      expect(find("[data-claws-confirm] button")).toHaveProperty("disabled", false),
    );
    const original = request.getMockImplementation()!;
    const oldApply = createDeferredCore();
    const newApply = createDeferredCore();
    let applications = 0;
    request.mockImplementation(async (method, params, options) => {
      if (method === "claws.add.apply") {
        await (applications++ === 0 ? oldApply.promise : newApply.promise);
      }
      return original(method, params, options);
    });
    find("[data-claws-confirm] button")!.click();
    await waitForSolid(() =>
      expect(find("[data-claws-confirm] button")?.textContent).toContain("Adding"),
    );
    setPhase("reconnecting");
    await waitForSolid(() =>
      expect(find("[data-claws-confirm] button")?.textContent).not.toContain("Adding"),
    );
    setPhase("connected");
    await waitForSolid(() => {
      expect(
        request.mock.calls.filter(([method]) => method === "claws.catalog.detail"),
      ).toHaveLength(2);
      expect(find(".plugin-capabilities")).not.toBeNull();
      expect(find("[data-claws-confirm] button")).toHaveProperty("disabled", false);
      expect(find("[data-claws-confirm] button")?.getAttribute("aria-busy")).toBeNull();
    });
    find("[data-claws-confirm] button")!.click();
    expect(applications).toBe(2);
    await waitForSolid(() =>
      expect(find("[data-claws-confirm] button")?.textContent).toContain("Adding"),
    );
    oldApply.resolve();
    await nextTurn();
    flush();
    expect(find("[data-claws-confirm] button")?.getAttribute("aria-busy")).toBe("true");
    expect(find("[data-claws-confirm] button")?.textContent).toContain("Adding");
    expect(navigate).not.toHaveBeenCalledWith("chat", expect.anything());
    newApply.resolve();
    await waitForSolid(() =>
      expect(navigate).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ pathname: "/chat/workflow-operator-2" }),
      ),
    );
    expect(applications).toBe(2);
  });

  it("retries an acknowledged agent handoff without applying the Claw again", async () => {
    const { find, request, navigate } = createDetail({ clawsEnabled: true });
    await waitForSolid(() =>
      expect(find("[data-claws-confirm] button")).toHaveProperty("disabled", false),
    );
    const original = request.getMockImplementation()!;
    let rosterUnavailable = true;
    vi.useFakeTimers({ toFake: ["Date"] });
    request.mockImplementation((method, params, options) => {
      if (method === "agents.list" && rosterUnavailable) {
        vi.setSystemTime(Date.now() + 15_001);
        throw new Error("Roster unavailable");
      }
      return original(method, params, options);
    });
    find("[data-claws-confirm] button")!.click();
    await waitForSolid(() =>
      expect(find("[role=alert] button")?.textContent).toContain("Open chat"),
    );
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalledWith("chat", expect.anything());
    rosterUnavailable = false;
    find("[role=alert] button")!.click();
    await waitForSolid(() =>
      expect(navigate).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ pathname: "/chat/workflow-operator" }),
      ),
    );
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
  });

  it("retains the selected Claw on revalidation and clears it when the package changes", async () => {
    const { detail, request, setPackageName } = createDetail({ clawsEnabled: true });

    await vi.waitFor(() =>
      expect(detail.querySelector(".plugin-capabilities")?.textContent).toContain("AGENTS.md"),
    );
    const selected = detail.querySelector(".plugin-capabilities");
    const searches = request.mock.calls.filter(([method]) => method === "claws.catalog.search");
    setPackageName(workflowOperator.packageName);
    await waitForSolid(() => {
      expect(detail.querySelector(".plugin-capabilities")).toBe(selected);
      expect(request.mock.calls.filter(([method]) => method === "claws.catalog.search")).toEqual(
        searches,
      );
    });
    setPackageName("@openclaw/another-claw");

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.catalog.search", {
        query: "@openclaw/another-claw",
        limit: 100,
      }),
    );
    await vi.waitFor(() => expect(detail.querySelector(".plugin-capabilities")).toBeNull());
    expect(detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")).toBeNull();
  });

  it("retires a pending Add when the package route changes", async () => {
    let finishApply: (() => void) | undefined;
    const applyWait = new Promise<void>((resolve) => {
      finishApply = resolve;
    });
    const { detail, request, navigate, setPackageName } = createDetail({
      clawsEnabled: true,
      applyWait,
    });

    await vi.waitFor(() =>
      expect(detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.disabled).toBe(
        false,
      ),
    );
    detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.click();
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([method]) => method === "claws.add.apply")).toBe(true),
    );

    setPackageName("@openclaw/another-claw");
    await vi.waitFor(() => expect(detail.querySelector(".plugin-capabilities")).toBeNull());
    setPackageName(workflowOperator.packageName);
    await vi.waitFor(() =>
      expect(detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.disabled).toBe(
        false,
      ),
    );
    finishApply?.();
    detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.click();
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ pathname: "/chat/workflow-operator-2" }),
      ),
    );
    expect(navigate.mock.calls.filter(([route]) => route === "chat")).toHaveLength(1);
  });

  it("asks before acknowledging a ClawHub trust warning", async () => {
    const { detail, request, navigate } = createDetail({
      clawsEnabled: true,
      riskConsentRequired: true,
      clawHubTrustWarning: "Review this release before adding it.",
    });

    await vi.waitFor(() =>
      expect(detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.disabled).toBe(
        false,
      ),
    );
    detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.click();

    await vi.waitFor(() =>
      expect(detail.querySelector(".claws-trust-warning")?.textContent).toContain(
        "Review this release before adding it.",
      ),
    );
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    expect(
      request.mock.calls.find(([method]) => method === "claws.add.apply")?.[1],
    ).not.toHaveProperty("acknowledgeClawHubRisk");
    expect(navigate).not.toHaveBeenCalledWith("chat", expect.anything());

    detail.querySelector<HTMLButtonElement>(".claws-add-consent__actions .btn")?.click();
    await vi.waitFor(() => expect(detail.querySelector(".claws-add-consent")).toBeNull());
    detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.click();
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(2),
    );
    expect(
      request.mock.calls.findLast(([method]) => method === "claws.add.apply")?.[1],
    ).not.toHaveProperty("acknowledgeClawHubRisk");
    await vi.waitFor(() => expect(detail.querySelector(".claws-trust-warning")).not.toBeNull());

    detail.querySelector<HTMLButtonElement>(".claws-add-consent__actions .btn.primary")?.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("chat", expect.anything()));
    expect(
      request.mock.calls.findLast(([method]) => method === "claws.add.apply")?.[1],
    ).toHaveProperty("acknowledgeClawHubRisk", true);
  });

  it.each(["plugin", "skill"] as const)("asks before applying a %s review plan", async (kind) => {
    const { detail, request, navigate } = createDetail({
      clawsEnabled: true,
      reviewRequiredOnce: kind,
    });

    await vi.waitFor(() =>
      expect(detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.disabled).toBe(
        false,
      ),
    );
    detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.click();

    await vi.waitFor(() =>
      expect(detail.querySelector(".claws-add-consent")?.textContent).toContain(
        kind === "plugin" ? "@openclaw/workflow-tools" : "@openclaw/research",
      ),
    );
    if (kind === "plugin") {
      expect(detail.querySelector(".claws-add-consent")?.textContent).toContain(
        "Conversation access: Allowed",
      );
    }
    expect(request.mock.calls.filter(([method]) => method === "claws.add.plan")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalledWith("chat", expect.anything());

    detail.querySelector<HTMLButtonElement>(".claws-add-consent__actions .btn.primary")?.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("chat", expect.anything()));
    const applyParams = request.mock.calls.findLast(
      ([method]) => method === "claws.add.apply",
    )?.[1];
    expect(applyParams).toHaveProperty("planIntegrity", "sha256:reviewed-plan");
    expect(applyParams).not.toHaveProperty("acknowledgeClawHubRisk");
  });

  it("requires both consents when trust and plugin review are needed", async () => {
    const { detail, request, navigate } = createDetail({
      clawsEnabled: true,
      riskConsentRequired: true,
      reviewRequiredOnce: "plugin",
    });

    await vi.waitFor(() =>
      expect(detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.disabled).toBe(
        false,
      ),
    );
    detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.click();
    await vi.waitFor(() => expect(detail.querySelector(".claws-trust-warning")).not.toBeNull());
    detail.querySelector<HTMLButtonElement>(".claws-add-consent__actions .btn.primary")?.click();

    await vi.waitFor(() =>
      expect(detail.querySelector(".claws-add-consent")?.textContent ?? "").toContain(
        "@openclaw/workflow-tools",
      ),
    );
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(2);
    expect(navigate).not.toHaveBeenCalledWith("chat", expect.anything());

    detail.querySelector<HTMLButtonElement>(".claws-add-consent__actions .btn.primary")?.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("chat", expect.anything()));
    const applyParams = request.mock.calls.findLast(
      ([method]) => method === "claws.add.apply",
    )?.[1];
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
