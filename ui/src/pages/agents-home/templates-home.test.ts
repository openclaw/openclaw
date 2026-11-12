/* @vitest-environment jsdom */

import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import "../../lib/toast-host.tsx";
// Register the toast renderer’s document-scoped avatar listener before per-test leak tracking.
import "../../lib/toast-view.tsx";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { page as templatesRoute } from "../templates/route.ts";
import {
  cleanupAgentsHomePageTest,
  createPage,
  setupAgentsHomePageTest,
  workflowOperator,
} from "./agents-home-page.test-helpers.ts";
import { createDetail } from "./templates-catalog.test-helpers.ts";

beforeEach(setupAgentsHomePageTest);
afterEach(cleanupAgentsHomePageTest);

describe("Templates discovery", () => {
  it.each([
    {
      names: ["AGENTS.md", "SOUL.md", "USER.md", "notes/context.md"],
      ordered: ["SOUL.md", "AGENTS.md", "USER.md", "View all"],
    },
    { names: ["USER.md", "notes/context.md"], ordered: ["USER.md", "View all"] },
    { names: ["templates/AGENTS.md", "fixtures/request.json"], ordered: ["View all"] },
    { names: ["IDENTITY.md"], ordered: ["IDENTITY.md"] },
  ])(
    "lists only root agent documents and a View all row for $names",
    async ({ names, ordered }) => {
      const { detail } = createDetail({ templatesEnabled: true, workspaceFileNames: names });
      await vi.waitFor(() => expect(detail.querySelector(".plugin-capabilities")).not.toBeNull());
      const section = detail.querySelector(".plugin-capabilities")!;
      const titles = [...section.querySelectorAll(".settings-row__title")].map(
        (node) => node.textContent,
      );
      expect(titles).toEqual(ordered);
      expect(section.querySelectorAll(".templates-workspace-file__info")).toHaveLength(
        ordered.filter((name) => name !== "View all").length,
      );
    },
  );

  it("opens named files and View all in the shared complete-file preview without navigating from help", async () => {
    const names = [
      "AGENTS.md",
      "SOUL.md",
      "USER.md",
      "BOOTSTRAP.md",
      "templates/AGENTS.md",
      "fixtures/request.json",
      "schemas/report.json",
      "avatars/agent.svg",
    ];
    const { detail, request } = createDetail({ templatesEnabled: true, workspaceFileNames: names });
    await vi.waitFor(() =>
      expect(detail.querySelector(".templates-workspace-file__info")).not.toBeNull(),
    );
    const section = detail.querySelector(".plugin-capabilities")!;
    section.querySelector<HTMLButtonElement>(".templates-workspace-file__info")!.click();
    expect(
      request.mock.calls.filter(([method]) => method === "templates.catalog.preview"),
    ).toHaveLength(0);
    section.querySelector<HTMLButtonElement>(".templates-workspace-file__open")!.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "templates.catalog.preview",
        expect.objectContaining({ name: "SOUL.md" }),
      ),
    );
    const preview = detail.querySelector("openclaw-file-preview-modal")!;
    expect(preview.files.map((file) => file.path)).toEqual(names);
    expect(section.querySelectorAll(".templates-workspace-file__open")).toHaveLength(5);
    preview.dispatchEvent(new CustomEvent("file-preview-close", { bubbles: true }));
    await waitForSolid(() =>
      expect(detail.querySelector("openclaw-file-preview-modal")).toBeNull(),
    );
    [...section.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "View all")!
      .click();
    await waitForSolid(() =>
      expect(detail.querySelector("openclaw-file-preview-modal")).not.toBeNull(),
    );
    const allFilesPreview = detail.querySelector("openclaw-file-preview-modal")!;
    expect(allFilesPreview.files.map((file) => file.path)).toEqual(names);
    for (const name of names) {
      allFilesPreview.dispatchEvent(
        new CustomEvent("file-preview-select", { detail: name, bubbles: true }),
      );
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "templates.catalog.preview",
          expect.objectContaining({ name }),
        ),
      );
    }
  });

  it("releases a closed preview before transport settles and isolates its replacement", async () => {
    const { detail, request } = createDetail({ templatesEnabled: true });
    await waitForSolid(() =>
      expect(detail.querySelector(".templates-workspace-file__open")).not.toBeNull(),
    );
    const retired = createDeferredCore<unknown>();
    request.mockReturnValueOnce(retired.promise);
    detail.querySelector<HTMLButtonElement>(".templates-workspace-file__open")!.click();
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
    detail.querySelector<HTMLButtonElement>(".templates-workspace-file__open")!.click();
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
    "/templates",
    "/templates/workflow-operator",
    "/templates/packages/%40openclaw%2Fworkflow-operator",
  ])("rejects direct visits to %s while Labs is disabled", async (pathname) => {
    const { context, page, request, ensureConfigLoaded } = createPage({ pathname });
    const location = { pathname, search: "", hash: "" };
    const result = await templatesRoute.loader!(
      context,
      createRouteLoaderOptions(location, templatesRoute.loaderDeps!(context, location)),
    );
    expect(result).toEqual({ type: "notFound", data: undefined });
    expect(ensureConfigLoaded).not.toHaveBeenCalled();
    expect(page.textContent).toContain("Templates is turned off");
    expect(page.querySelector("[data-templates-explore]")).toBeNull();
    expect(page.querySelector("[data-templates-confirm]")).toBeNull();
    expect(request.mock.calls.some(([method]) => method.startsWith("templates."))).toBe(false);
  });

  it("removes discovery when the Labs toggle is disabled during a visit", async () => {
    const { page, setTemplatesEnabled } = createPage({ templatesEnabled: true });
    await vi.waitFor(() => expect(page.querySelectorAll("[data-templates-entry]")).toHaveLength(1));
    setTemplatesEnabled(false);
    await vi.waitFor(() => expect(page.querySelector("[data-templates-explore]")).toBeNull());
    expect(page.textContent).toContain("Templates is turned off");
  });

  it("shows official Templates and opens their dedicated route", async () => {
    const { page, navigate, request } = createPage({ templatesEnabled: true });
    await vi.waitFor(() => expect(page.querySelectorAll("[data-templates-entry]")).toHaveLength(1));
    expect(page.querySelector(".hub-page-header h1.page-title")?.textContent).toBe("Templates");
    expect(page.querySelector(".settings-page [data-templates-search]")).not.toBeNull();
    expect(page.querySelector(".settings-page .hub-page-header")).toBeNull();
    expect(page.querySelector(".agents-home__card")).toBeNull();
    expect(page.textContent).not.toContain("Manage agents");
    expect(request.mock.calls.some(([method]) => method === "sessions.list")).toBe(false);

    page.querySelector<HTMLButtonElement>(".agents-home__template-card-link")?.click();
    expect(navigate).toHaveBeenCalledWith("templates", {
      pathname: "/templates/packages/%40openclaw%2Fworkflow-operator",
      search: "?version=1.2.0",
    });
    expect(request).toHaveBeenCalledWith("templates.catalog.search", {
      overview: true,
      limit: 8,
    });
  });

  it("updates Explore results when the search changes", async () => {
    const { page, request } = createPage({ templatesEnabled: true });
    await vi.waitFor(() => expect(page.querySelectorAll("[data-templates-entry]")).toHaveLength(1));

    const search = page.querySelector<HTMLInputElement>("[data-templates-search]");
    expect(search).not.toBeNull();
    search!.value = "missing";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(page.querySelectorAll("[data-templates-entry]")).toHaveLength(0));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("templates.catalog.search", { query: "missing" }),
    );

    search!.value = "workflow";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(page.querySelectorAll("[data-templates-entry]")).toHaveLength(1));
  });

  it("retries the selected package's detail read while retaining its route", async () => {
    const { request, setTemplatesEnabled, find } = createDetail({ templatesEnabled: false });
    const original = request.getMockImplementation()!;
    const pending = createDeferredCore<unknown>();
    const recovered = createDeferredCore<unknown>();
    let attempts = 0;
    request.mockImplementation((method, params, options) => {
      if (method === "templates.catalog.detail") {
        return ++attempts === 1 ? pending.promise : recovered.promise;
      }
      return original(method, params, options);
    });
    setTemplatesEnabled(true);
    await waitForSolid(() => expect(attempts).toBe(1));
    const back = find(".plugin-catalog-detail__back");
    expect(back?.getAttribute("href")).toBe("/templates");
    expect(find(".plugin-catalog-detail--loading")).not.toBeNull();
    expect(find("[data-templates-confirm]")).toBeNull();
    pending.reject(new Error("Catalog temporarily unavailable"));
    await waitForSolid(() =>
      expect(find("[role=alert]")?.textContent).toContain("Catalog temporarily unavailable"),
    );
    find("[role=alert] button")!.click();
    await waitForSolid(() => expect(attempts).toBe(2));
    expect(find("[role=alert]")).toBeNull();
    expect(find(".plugin-catalog-detail__back")).toBe(back);
    expect(find("[data-templates-confirm]")).toBeNull();
    recovered.resolve(await original("templates.catalog.detail", {}));
    await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
    expect(request).toHaveBeenCalledWith("templates.catalog.detail", {
      packageName: workflowOperator.packageName,
    });
  });

  it("retires a pending detail reply when the package route changes", async () => {
    const { request, setTemplatesEnabled, setPackageName, find } = createDetail({
      templatesEnabled: false,
    });
    const original = request.getMockImplementation()!;
    const retired = createDeferredCore<unknown>();
    request.mockImplementation((method, params, options) => {
      if (
        method === "templates.catalog.detail" &&
        params &&
        typeof params === "object" &&
        Reflect.get(params, "packageName") === workflowOperator.packageName
      ) {
        return retired.promise;
      }
      return original(method, params, options);
    });
    setTemplatesEnabled(true);
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("templates.catalog.detail", {
        packageName: workflowOperator.packageName,
      }),
    );
    setPackageName("@openclaw/missing");
    await waitForSolid(() => expect(find("[role=alert]")).not.toBeNull());
    const error = find("[role=alert]")?.textContent;
    retired.resolve(await original("templates.catalog.detail", {}));
    await retired.promise;
    await nextTurn();
    flush();
    expect(find("[role=alert]")?.textContent).toBe(error);
    expect(find(".plugin-capabilities")).toBeNull();
    expect(find("[data-templates-confirm]")).toBeNull();
    expect(
      request.mock.calls.filter(([method]) => method === "templates.catalog.detail"),
    ).toHaveLength(2);
  });

  it("refreshes a selected Template after reconnect and ignores the retired detail reply", async () => {
    const { request, setPhase, find } = createDetail({ templatesEnabled: true });
    await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
    const original = request.getMockImplementation()!;
    const stale = createDeferredCore<unknown>();
    let searches = 0;
    request.mockImplementation((method, params, options) => {
      if (method === "templates.catalog.detail" && ++searches === 1) {
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
        request.mock.calls.filter(([method]) => method === "templates.catalog.detail"),
      ).toHaveLength(3),
    );
    await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
    const response = (await original("templates.catalog.detail", {})) as {
      detail: Record<string, unknown>;
    };
    stale.resolve({ detail: { ...response.detail, version: "9.9.9" } });
    await stale.promise;
    await nextTurn();
    flush();
    expect(
      request.mock.calls.filter(([method]) => method === "templates.catalog.detail"),
    ).toHaveLength(3);
    expect(find(".plugin-capabilities")).not.toBeNull();
  });

  it.each([undefined, workflowOperator.latestVersion])(
    "loads contents without search and pins Add to resolved release (version: %s)",
    async (version) => {
      const { detail, request, navigate, setTemplatesEnabled } = createDetail(
        { templatesEnabled: false },
        version,
      );
      const original = request.getMockImplementation()!;
      const search = createDeferredCore<unknown>();
      request.mockImplementation((method, params, options) =>
        method === "templates.catalog.search" ? search.promise : original(method, params, options),
      );
      setTemplatesEnabled(true);

      await waitForSolid(() =>
        expect(detail.querySelector("[data-templates-confirm] button")).toHaveProperty(
          "disabled",
          false,
        ),
      );
      expect(request).toHaveBeenCalledWith("templates.catalog.detail", {
        packageName: workflowOperator.packageName,
        ...(version ? { version } : {}),
      });
      const source = {
        packageName: workflowOperator.packageName,
        version: workflowOperator.latestVersion,
      };
      expect(request).toHaveBeenCalledWith("templates.add.plan", { source });

      expect(request.mock.calls.some(([method]) => method === "templates.add.apply")).toBe(false);
      detail.querySelector<HTMLButtonElement>("[data-templates-confirm] button")?.click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("chat", expect.anything()));
      expect(request).toHaveBeenCalledWith(
        "templates.add.apply",
        expect.objectContaining({ source }),
        expect.objectContaining({ onSent: expect.any(Function) }),
      );
    },
  );

  it("retries a failed detail read without replacing the shell or admitting Add early", async () => {
    const { request, setPhase, find } = createDetail({ templatesEnabled: true });
    await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
    const addButton = find("[data-templates-confirm] button");
    const original = request.getMockImplementation()!;
    const retry = createDeferredCore<unknown>();
    let attempts = 0;
    request.mockImplementation((method, params, options) => {
      if (method === "templates.catalog.detail") {
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
    expect(find("[data-templates-confirm] button")).toBe(addButton);
    expect(addButton).toHaveProperty("disabled", true);
    expect(find(".plugin-capabilities")).toBeNull();
    find("[role=alert] button")!.click();
    await waitForSolid(() => expect(find(".templates-content-skeleton")).not.toBeNull());
    expect(find("[role=alert]")).toBeNull();
    expect(addButton).toHaveProperty("disabled", true);
    retry.resolve(await original("templates.catalog.detail", {}));
    await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
    expect(attempts).toBe(2);
    expect(find("[data-templates-confirm] button")).toBe(addButton);
    expect(addButton).toHaveProperty("disabled", false);
  });

  it("retires pending detail loading immediately on disconnect and ignores its late failure", async () => {
    const { request, setPhase, find } = createDetail({ templatesEnabled: true });
    await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
    const original = request.getMockImplementation()!;
    const stale = createDeferredCore<unknown>();
    let reads = 0;
    request.mockImplementation((method, params, options) => {
      if (method === "templates.catalog.detail" && ++reads === 1) {
        return stale.promise;
      }
      return original(method, params, options);
    });
    setPhase("reconnecting");
    flush();
    expect(find(".plugin-capabilities")).not.toBeNull();
    setPhase("connected");
    await waitForSolid(() => expect(find(".templates-content-skeleton")).not.toBeNull());
    expect(find("[data-templates-confirm] button")).toHaveProperty("disabled", true);
    setPhase("reconnecting");
    await waitForSolid(() => expect(find(".templates-content-skeleton")).toBeNull());
    expect(find(".plugin-capabilities")).toBeNull();
    expect(find("[data-templates-confirm] button")).toHaveProperty("disabled", true);
    setPhase("connected");
    await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
    stale.reject(new Error("Retired detail failed"));
    await stale.promise.catch(() => {});
    flush();
    expect(reads).toBe(2);
    expect(find("[role=alert]")).toBeNull();
    expect(find(".plugin-capabilities")).not.toBeNull();
    expect(find("[data-templates-confirm] button")).toHaveProperty("disabled", false);
  });

  it("falls back to legacy shelves only for an unsupported overview and retires pending probes", async () => {
    const { page, request, setPhase } = createPage({ templatesEnabled: true });
    await waitForSolid(() =>
      expect(page.querySelectorAll("[data-templates-entry]")).toHaveLength(1),
    );
    const original = request.getMockImplementation()!;
    const retired = createDeferredCore<unknown>();
    let overviewReads = 0;
    request.mockImplementation((method, params, options) => {
      if (
        method === "templates.catalog.search" &&
        params &&
        typeof params === "object" &&
        Reflect.get(params, "overview")
      ) {
        return ++overviewReads === 1 ? { entries: [] } : retired.promise;
      }
      return original(method, params, options);
    });
    setPhase("reconnecting");
    flush();
    setPhase("connected");
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("templates.catalog.search", {
        category: "productivity",
        limit: 8,
      }),
    );
    await waitForSolid(() =>
      expect(page.querySelectorAll("[data-templates-entry]")).toHaveLength(1),
    );
    setPhase("reconnecting");
    flush();
    setPhase("connected");
    await waitForSolid(() => expect(overviewReads).toBe(2));
    const search = page.querySelector<HTMLInputElement>("[data-templates-search]")!;
    search.value = "missing";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForSolid(() => expect(page.textContent).toContain("No templates match your search."));
    const reads = request.mock.calls.length;
    retired.resolve({ entries: [] });
    await retired.promise;
    flush();
    expect(request.mock.calls).toHaveLength(reads);
    expect(page.querySelectorAll("[data-templates-entry]")).toHaveLength(0);
  });

  it("cancels superseded Explore debounce and ignores an older search result", async () => {
    const { page, request } = createPage({ templatesEnabled: true });
    await waitForSolid(() =>
      expect(page.querySelectorAll("[data-templates-entry]")).toHaveLength(1),
    );
    const original = request.getMockImplementation()!;
    const stale = createDeferredCore<{ entries: (typeof workflowOperator)[] }>();
    request.mockImplementation((method, params, options) => {
      if (method === "templates.catalog.search") {
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
      "[data-templates-explore] [data-templates-search]",
    )!;
    const enter = (query: string) => {
      search.value = query;
      search.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
    };
    enter("cancelled");
    enter("stale");
    const loading = page.querySelectorAll('[role="status"][aria-label="Loading templates…"]');
    expect(loading).toHaveLength(1);
    expect(loading[0]!.children.length).toBeGreaterThan(0);
    expect(
      Array.from(loading[0]!.children).every((card) => card.getAttribute("aria-hidden") === "true"),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(149);
    expect(request).not.toHaveBeenCalledWith("templates.catalog.search", { query: "stale" });
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledWith("templates.catalog.search", { query: "stale" });
    expect(request).not.toHaveBeenCalledWith("templates.catalog.search", { query: "cancelled" });

    enter("fresh");
    await vi.advanceTimersByTimeAsync(150);
    await waitForSolid(() =>
      expect(page.querySelector("[data-templates-results]")?.textContent).toContain("Fresh result"),
    );
    expect(page.querySelector('[role="status"][aria-label="Loading templates…"]')).toBeNull();
    stale.resolve({ entries: [workflowOperator] });
    await stale.promise;
    flush();
    expect(page.querySelector("[data-templates-results]")?.textContent).toContain("Fresh result");
    expect(page.querySelector("[data-templates-results]")?.textContent).not.toContain(
      "Workflow Operator",
    );
  });

  it("retries the current Explore query after a failed search", async () => {
    const { page, request } = createPage({ templatesEnabled: true });
    await waitForSolid(() =>
      expect(page.querySelectorAll("[data-templates-entry]")).toHaveLength(1),
    );
    const original = request.getMockImplementation()!;
    let attempts = 0;
    request.mockImplementation((method, params, options) => {
      const query = params && typeof params === "object" ? Reflect.get(params, "query") : undefined;
      if (method === "templates.catalog.search" && query === "retry") {
        if (++attempts === 1) {
          throw new Error("Search temporarily unavailable");
        }
        return { entries: [workflowOperator] };
      }
      return original(method, params, options);
    });
    const search = page.querySelector<HTMLInputElement>(
      "[data-templates-explore] [data-templates-search]",
    )!;
    search.value = "retry";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForSolid(() =>
      expect(page.querySelector("[data-templates-explore] [role=alert]")?.textContent).toContain(
        "Search temporarily unavailable",
      ),
    );
    page.querySelector<HTMLButtonElement>("[data-templates-explore] [role=alert] button")!.click();
    await waitForSolid(() =>
      expect(page.querySelectorAll("[data-templates-results] [data-templates-entry]")).toHaveLength(
        1,
      ),
    );
    expect(attempts).toBe(2);
    expect(search.value).toBe("retry");
    expect(page.querySelector("[data-templates-explore] [role=alert]")).toBeNull();
  });
});

it.each(["card", "detail"])(
  "shows Template artwork and falls back on an image error in the %s",
  async (surface) => {
    const templateIconUrl = `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`;
    const options = { templateIconUrl, templatesEnabled: true };
    const container = surface === "card" ? createPage(options).page : createDetail(options).detail;
    const selector =
      surface === "card" ? ".agents-home__template-art" : ".plugin-catalog-detail__icon";
    await waitForSolid(() =>
      expect(container.querySelector(`${selector} img`)?.getAttribute("src")).toBe(templateIconUrl),
    );
    const image = container.querySelector(`${selector} img`)!;
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(image.getAttribute("crossorigin")).toBe("anonymous");
    image.dispatchEvent(new Event("error"));
    await waitForSolid(() => expect(container.querySelector(`${selector} img`)).toBeNull());
    expect(container.querySelector(`${selector} svg`)).not.toBeNull();
  },
);
