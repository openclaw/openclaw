/* @vitest-environment jsdom */

import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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

/** jsdom has no image decoding; tests decide when catalog artwork becomes ready. */
function stubImageDecode(decode: () => Promise<void>) {
  const stub = vi.fn(decode);
  HTMLImageElement.prototype.decode = stub;
  onTestFinished(() => {
    Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  });
  return stub;
}

function openCertifiedShelf() {
  const fixture = createPage({ templatesEnabled: false });
  const cards = Array.from({ length: 6 }, (_, index) => ({
    ...workflowOperator,
    packageName: `@openclaw/card-${index + 1}`,
    displayName: `Card ${index + 1}`,
    iconUrl: `https://clawhub.ai/api/v1/skill-icons/${String(index + 1).repeat(64)}`,
  }));
  const original = fixture.request.getMockImplementation()!;
  fixture.request.mockImplementation((method, params, options) =>
    method === "templates.catalog.search" &&
    params &&
    typeof params === "object" &&
    "overview" in params
      ? {
          entries: [],
          overview: {
            featured: [],
            sections: [
              {
                category: "productivity",
                entries: cards.slice(0, 4),
                additionalEntries: [...cards.slice(4), { ...workflowOperator, channel: "private" }],
              },
            ],
          },
        }
      : original(method, params, options),
  );
  fixture.setTemplatesEnabled(true);
  return fixture;
}

describe("Templates discovery", () => {
  it("opens the complete workspace inventory from Personality and reads the selected file", async () => {
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
      expect(detail.querySelector(".templates-personality__file")?.textContent).toBe("SOUL.md"),
    );
    detail.querySelector<HTMLButtonElement>(".templates-personality__file")!.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "templates.catalog.preview",
        expect.objectContaining({ name: "SOUL.md" }),
      ),
    );
    const preview = detail.querySelector("openclaw-file-preview-modal")!;
    expect(preview.files.map((file) => file.path)).toEqual(names);
    for (const name of names.filter((fileName) => fileName !== "SOUL.md")) {
      preview.dispatchEvent(
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
      expect(detail.querySelector(".templates-personality__file")).not.toBeNull(),
    );
    const retired = createDeferredCore<unknown>();
    request.mockReturnValueOnce(retired.promise);
    detail.querySelector<HTMLButtonElement>(".templates-personality__file")!.click();
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
    detail.querySelector<HTMLButtonElement>(".templates-personality__file")!.click();
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
    const subtitle = page.querySelector(".hub-page-header .page-subtitle");
    expect(subtitle?.textContent).toBe("Ready-made Claws that get the job done Learn more");
    expect(subtitle?.querySelector("a")?.getAttribute("href")).toBe(
      "https://docs.openclaw.ai/concepts/agents-and-templates",
    );
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
      includeCategoryEntries: true,
      limit: 4,
    });
  });

  it("shows the full category without preloading decorative artwork a second time", async () => {
    const decode = stubImageDecode(async () => {});
    const { page, request } = createPage({
      templatesEnabled: true,
      templateIconUrl: `https://clawhub.ai/api/v1/skill-icons/${"e".repeat(64)}`,
    });
    const shelf = '[data-catalog-section="productivity"]';
    await waitForSolid(() => expect(page.querySelector(shelf)).not.toBeNull());
    expect(decode).toHaveBeenCalledOnce();
    page.querySelector<HTMLButtonElement>(shelf + " .plugin-catalog-section__view-all")!.click();
    await waitForSolid(() =>
      expect(page.querySelector(shelf + " [data-templates-results] img")).not.toBeNull(),
    );
    expect(request).toHaveBeenCalledWith("templates.catalog.search", { category: "productivity" });
    expect(decode).toHaveBeenCalledOnce();
  });

  it("expands the four visible cards to the complete public shelf without another request or artwork wait", async () => {
    const decode = stubImageDecode(async () => {});
    const { page, request } = openCertifiedShelf();
    const names = () =>
      [...page.querySelectorAll("[data-templates-entry] h3")].map((node) => node.textContent);
    await waitForSolid(() => expect(names()).toEqual(["Card 1", "Card 2", "Card 3", "Card 4"]));
    expect(
      request.mock.calls.filter(([method]) => method === "templates.catalog.search"),
    ).toHaveLength(1);
    expect(decode).toHaveBeenCalledTimes(4);
    request.mockClear();
    page.querySelector<HTMLButtonElement>(".plugin-catalog-section__view-all")!.click();
    flush();
    expect(page.querySelector("[data-templates-placeholder]")).toBeNull();
    expect(names()).toEqual(["Card 1", "Card 2", "Card 3", "Card 4", "Card 5", "Card 6"]);
    expect(page.querySelector("[data-templates-results]")).not.toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(decode).toHaveBeenCalledTimes(4);
    expect(page.querySelector('.plugin-catalog-chip[aria-pressed="true"]')?.textContent).toBe(
      "Productivity",
    );

    const search = page.querySelector<HTMLInputElement>("[data-templates-search]")!;
    search.value = "workflow";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForSolid(() => expect(names()).toEqual(["Workflow Operator"]));
    expect(request).toHaveBeenCalledWith("templates.catalog.search", {
      query: "workflow",
      category: "productivity",
    });
  });

  it.each(["expired shelf", "retired connection", "superseded shelf", "category chip"])(
    "reads the selected category from the Gateway: %s",
    async (selection) => {
      stubImageDecode(async () => {});
      const { page, request, setPhase } = openCertifiedShelf();
      await waitForSolid(() =>
        expect(page.querySelectorAll("[data-templates-entry]")).toHaveLength(4),
      );
      const viewAll = page.querySelector<HTMLButtonElement>(".plugin-catalog-section__view-all")!;
      const clickChip = (label: string) =>
        [...page.querySelectorAll<HTMLButtonElement>(".plugin-catalog-chip")]
          .find((chip) => chip.textContent === label)!
          .click();
      if (selection === "expired shelf") {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 60_000);
      } else if (selection === "retired connection") {
        // The old row can still receive a click before Solid flushes the new connection.
        setPhase("reconnecting");
        setPhase("connected");
      } else if (selection === "superseded shelf") {
        clickChip("Health");
      }
      if (selection === "category chip") {
        clickChip("Productivity");
      } else {
        viewAll.click();
      }
      await waitForSolid(() =>
        expect(page.querySelector("[data-templates-results] h3")?.textContent).toBe(
          "Workflow Operator",
        ),
      );
      expect(request).toHaveBeenCalledWith("templates.catalog.search", {
        category: "productivity",
      });
      expect(page.querySelectorAll("[data-templates-entry]")).toHaveLength(1);
    },
  );

  it("lists the category chips in catalog order and filters by the selected slug", async () => {
    const { page, request } = createPage({ templatesEnabled: true });
    await vi.waitFor(() => expect(page.querySelectorAll("[data-templates-entry]")).toHaveLength(1));

    const chips = [...page.querySelectorAll<HTMLButtonElement>(".plugin-catalog-chip")];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "All",
      "Engineering",
      "Operations",
      "Household",
      "Entertainment",
      "Travel",
      "Productivity",
      "Research",
      "Health",
      "Sales",
      "Product",
      "Other",
    ]);
    expect(chips.every((chip) => chip.querySelector("svg"))).toBe(true);

    chips.find((chip) => chip.textContent === "Household")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("templates.catalog.search", { category: "household" }),
    );
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
      expect(request.mock.calls.some(([method]) => method === "templates.add.apply")).toBe(false);
      detail.querySelector<HTMLButtonElement>("[data-templates-confirm] button")?.click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("chat", expect.anything()));
      expect(request).toHaveBeenCalledWith(
        "templates.add.apply",
        { mode: "chat", source, agentId: "workflow-operator" },
        expect.objectContaining({ onSent: expect.any(Function) }),
      );
      expect(request.mock.calls.some(([method]) => method === "templates.add.plan")).toBe(false);
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
        limit: 4,
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
  "shows Template artwork and falls back to the Blobster in the %s",
  async (surface) => {
    const templateIconUrl = `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`;
    stubImageDecode(() => Promise.resolve());
    const create = (iconUrl?: string) => {
      const options = { templateIconUrl: iconUrl, templatesEnabled: true };
      return surface === "card" ? createPage(options).page : createDetail(options).detail;
    };
    const selector =
      surface === "card" ? ".agents-home__template-art" : ".plugin-catalog-detail__icon";
    // Only the Blobster fallback has two filled eyes; its stroke takes the container's color.
    const blobsterEyes = `${selector} svg[stroke="currentColor"] circle[fill="currentColor"]`;
    const withoutArtwork = create();
    await waitForSolid(() => expect(withoutArtwork.querySelectorAll(blobsterEyes)).toHaveLength(2));
    expect(withoutArtwork.querySelector(`${selector} img`)).toBeNull();

    const container = create(templateIconUrl);
    await waitForSolid(() =>
      expect(container.querySelector(`${selector} img`)?.getAttribute("src")).toBe(templateIconUrl),
    );
    const image = container.querySelector(`${selector} img`)!;
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(image.getAttribute("crossorigin")).toBe("anonymous");
    image.dispatchEvent(new Event("error"));
    await waitForSolid(() => expect(container.querySelector(`${selector} img`)).toBeNull());
    expect(container.querySelectorAll(blobsterEyes)).toHaveLength(2);
  },
);

it.each(["decoded", "failed"] as const)(
  "keeps the catalog placeholders until first-screen artwork has %s",
  async (outcome) => {
    const templateIconUrl = `https://clawhub.ai/api/v1/skill-icons/${"b".repeat(64)}`;
    const artwork = createDeferredCore();
    const decode = stubImageDecode(() => artwork.promise);
    const { page } = createPage({ templateIconUrl, templatesEnabled: true });
    await waitForSolid(() => expect(decode).toHaveBeenCalledOnce());
    const preloaded = decode.mock.contexts[0] as HTMLImageElement;
    // The preload must share the card image's request mode to reuse its response.
    expect(preloaded.src).toBe(templateIconUrl);
    expect(preloaded.crossOrigin).toBe("anonymous");
    expect(preloaded.referrerPolicy).toBe("no-referrer");
    await nextTurn();
    expect(page.querySelector("[data-templates-entry]")).toBeNull();
    expect(page.querySelectorAll("[data-templates-placeholder]")).not.toHaveLength(0);

    if (outcome === "decoded") {
      artwork.resolve();
    } else {
      artwork.reject(new Error("decode failed"));
    }
    await waitForSolid(() => expect(page.querySelector("[data-templates-entry]")).not.toBeNull());
    expect(page.querySelector("[data-templates-placeholder]")).toBeNull();
    expect(page.querySelector(".agents-home__template-art img")?.getAttribute("src")).toBe(
      templateIconUrl,
    );
  },
);

it("stops waiting for slow artwork after the reveal budget", async () => {
  vi.useFakeTimers();
  try {
    const templateIconUrl = `https://clawhub.ai/api/v1/skill-icons/${"c".repeat(64)}`;
    stubImageDecode(() => new Promise<void>(() => {}));
    const { page } = createPage({ templateIconUrl, templatesEnabled: true });
    await vi.advanceTimersByTimeAsync(499);
    expect(page.querySelector("[data-templates-entry]")).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await waitForSolid(() => expect(page.querySelector("[data-templates-entry]")).not.toBeNull());
  } finally {
    vi.useRealTimers();
  }
});
