/* @vitest-environment jsdom */

import { getQueriesForElement } from "@solidjs/testing-library";
import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { pathForClawCatalogEntry } from "../../app-route-paths.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ClawsPage } from "../claws/page.tsx";
import {
  cleanupAgentsHomePageTest,
  createPage,
  setupAgentsHomePageTest,
  workflowOperator,
} from "./agents-home-page.test-helpers.ts";

beforeEach(setupAgentsHomePageTest);
afterEach(cleanupAgentsHomePageTest);

function createDetail(options: Parameters<typeof createPage>[0] = {}) {
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
  const detail = view.container;
  const find = (selector: string) => detail.querySelector<HTMLElement>(selector);
  return {
    ...fixture,
    detail,
    find,
    calls: (method: string) => fixture.request.mock.calls.filter(([name]) => name === method),
    add: async () => {
      await vi.waitFor(() =>
        expect(find("[data-claws-confirm] button")).toHaveProperty("disabled", false),
      );
      detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.click();
    },
    setPackageName: (packageName: string) =>
      setLocation({ pathname: pathForClawCatalogEntry(packageName, ""), search: "", hash: "" }),
  };
}

it.each(["explore", "catalog"])("names the Add target in the %s view", async (surface) => {
  const { page, navigate, request, ensureConfigLoaded } = createPage();
  const queries = getQueriesForElement(page);
  if (surface === "catalog") {
    (await queries.findByRole<HTMLButtonElement>("button", { name: "Search Claws" })).click();
  }
  const container = surface === "catalog" ? ".claws-catalog" : "[data-claws-explore]";
  await vi.waitFor(() => expect(page.querySelector(container)).not.toBeNull());
  const view = getQueriesForElement(page.querySelector(container)!);
  const add = await view.findByRole<HTMLButtonElement>("button", {
    name: "Add Workflow Operator",
  });
  expect(ensureConfigLoaded).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith("claws.catalog.search", {});
  expect(add.textContent?.trim()).toBe("Add");
  add.click();
  expect(navigate).toHaveBeenCalledWith("claws", {
    pathname: "/agents/claws/packages/%40openclaw%2Fworkflow-operator",
  });
});

it.each([
  {
    names: ["AGENTS.md", "SOUL.md", "USER.md", "notes/context.md"],
    ordered: ["SOUL.md", "AGENTS.md", "USER.md", "notes/context.md"],
  },
  { names: ["USER.md", "notes/context.md"], ordered: ["USER.md", "notes/context.md"] },
  { names: ["IDENTITY.md"], ordered: ["IDENTITY.md"] },
])("lists every release file inline for $names", async ({ names, ordered }) => {
  const { find } = createDetail({ workspaceFileNames: names });
  await vi.waitFor(() => expect(find(".plugin-capabilities")).not.toBeNull());
  const section = find(".plugin-capabilities")!;
  expect(section.querySelector("h2 > span")?.textContent).toBe(String(names.length));
  const titles = [...section.querySelectorAll(".plugin-capability__copy strong")].map(
    (node) => node.textContent,
  );
  expect(titles).toEqual(ordered);
  expect(section.querySelectorAll(".claws-workspace-file__info")).toHaveLength(names.length);
});

it("updates Explore results when the search changes", async () => {
  const { page, request } = createPage();
  await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));

  const search = page.querySelector<HTMLInputElement>("[data-claws-explore] [data-claws-search]");
  expect(search).not.toBeNull();
  for (const [query, count] of [
    ["missing", 0],
    ["workflow", 1],
  ] as const) {
    search!.value = query;
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(count));
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("claws.catalog.search", { query }));
  }
});

it("cancels superseded Explore debounce and ignores an older search result", async () => {
  const { page, request } = createPage();
  await waitForSolid(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
  const original = request.getMockImplementation()!;
  const stale = createDeferredCore<{ entries: (typeof workflowOperator)[] }>();
  request.mockImplementation((method, params, options) => {
    if (method === "claws.catalog.search") {
      const query = params && typeof params === "object" ? Reflect.get(params, "query") : undefined;
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
  const search = page.querySelector<HTMLInputElement>("[data-claws-explore] [data-claws-search]")!;
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
  const { page, request } = createPage();
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
  const search = page.querySelector<HTMLInputElement>("[data-claws-explore] [data-claws-search]")!;
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

it("retains the selected Claw on revalidation and clears it when the package changes", async () => {
  const { request, setPackageName, find, calls } = createDetail();

  await vi.waitFor(() => expect(find(".plugin-capabilities")?.textContent).toContain("AGENTS.md"));
  const selected = find(".plugin-capabilities");
  const searches = calls("claws.catalog.search");
  setPackageName(workflowOperator.packageName);
  await waitForSolid(() => {
    expect(find(".plugin-capabilities")).toBe(selected);
    expect(calls("claws.catalog.search")).toEqual(searches);
  });
  setPackageName("@openclaw/another-claw");

  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("claws.catalog.search", {
      query: "@openclaw/another-claw",
      limit: 100,
    }),
  );
  await vi.waitFor(() => expect(find(".plugin-capabilities")).toBeNull());
  expect(find("[data-claws-confirm] button")).toBeNull();
});

it("retires a pending Add when the package route changes", async () => {
  let finishApply: (() => void) | undefined;
  const applyWait = new Promise<void>((resolve) => {
    finishApply = resolve;
  });
  const { navigate, setPackageName, find, calls, add } = createDetail({
    applyWait,
  });

  await add();
  await vi.waitFor(() => expect(calls("claws.add.apply")).not.toHaveLength(0));

  setPackageName("@openclaw/another-claw");
  await vi.waitFor(() => expect(find(".plugin-capabilities")).toBeNull());
  setPackageName(workflowOperator.packageName);
  await vi.waitFor(() =>
    expect(find("[data-claws-confirm] button")).toHaveProperty("disabled", false),
  );
  finishApply?.();
  find("[data-claws-confirm] button")?.click();
  await vi.waitFor(() =>
    expect(navigate).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/workflow-operator-2" }),
    ),
  );
  expect(navigate.mock.calls.filter(([route]) => route === "chat")).toHaveLength(1);
});

it("asks before acknowledging a ClawHub trust warning", async () => {
  const { navigate, find, calls, add } = createDetail({
    riskConsentRequired: true,
    clawHubTrustWarning: "Review this release before adding it.",
  });

  await add();

  await vi.waitFor(() =>
    expect(find(".claws-trust-warning")?.textContent).toContain(
      "Review this release before adding it.",
    ),
  );
  expect(calls("claws.add.apply")).toHaveLength(1);
  expect(calls("claws.add.apply")[0]?.[1]).not.toHaveProperty("acknowledgeClawHubRisk");
  expect(navigate).not.toHaveBeenCalledWith("chat", expect.anything());

  find(".claws-add-consent__actions .btn")?.click();
  await vi.waitFor(() => expect(find(".claws-add-consent")).toBeNull());
  find("[data-claws-confirm] button")?.click();
  await vi.waitFor(() => expect(calls("claws.add.apply")).toHaveLength(2));
  expect(calls("claws.add.apply").at(-1)?.[1]).not.toHaveProperty("acknowledgeClawHubRisk");
  await vi.waitFor(() => expect(find(".claws-trust-warning")).not.toBeNull());

  find(".claws-add-consent__actions .btn.primary")?.click();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("chat", expect.anything()));
  expect(calls("claws.add.apply").at(-1)?.[1]).toHaveProperty("acknowledgeClawHubRisk", true);
});

it.each(["plugin", "skill"] as const)("asks before applying a %s review plan", async (kind) => {
  const { navigate, find, calls, add } = createDetail({
    reviewRequiredOnce: kind,
  });

  await add();

  await vi.waitFor(() =>
    expect(find(".claws-add-consent")?.textContent).toContain(
      kind === "plugin" ? "@openclaw/workflow-tools" : "@openclaw/research",
    ),
  );
  if (kind === "plugin") {
    expect(find(".claws-add-consent")?.textContent).toContain("Conversation access: Allowed");
  }
  expect(calls("claws.add.plan")).toHaveLength(1);
  expect(calls("claws.add.apply")).toHaveLength(1);
  expect(navigate).not.toHaveBeenCalledWith("chat", expect.anything());

  find(".claws-add-consent__actions .btn.primary")?.click();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("chat", expect.anything()));
  const applyParams = calls("claws.add.apply").at(-1)?.[1];
  expect(applyParams).toHaveProperty("planIntegrity", "sha256:reviewed-plan");
  expect(applyParams).not.toHaveProperty("acknowledgeClawHubRisk");
});

it("requires both consents when trust and plugin review are needed", async () => {
  const { navigate, find, calls, add } = createDetail({
    riskConsentRequired: true,
    reviewRequiredOnce: "plugin",
  });

  await add();
  await vi.waitFor(() => expect(find(".claws-trust-warning")).not.toBeNull());
  find(".claws-add-consent__actions .btn.primary")?.click();

  await vi.waitFor(() =>
    expect(find(".claws-add-consent")?.textContent ?? "").toContain("@openclaw/workflow-tools"),
  );
  expect(calls("claws.add.apply")).toHaveLength(2);
  expect(navigate).not.toHaveBeenCalledWith("chat", expect.anything());

  find(".claws-add-consent__actions .btn.primary")?.click();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("chat", expect.anything()));
  const applyParams = calls("claws.add.apply").at(-1)?.[1];
  expect(applyParams).toMatchObject({
    acknowledgeClawHubRisk: true,
    planIntegrity: "sha256:reviewed-plan",
  });
});

it.each(["card", "detail"])(
  "shows Claw artwork and falls back on an image error in the %s",
  async (surface) => {
    const clawIconUrl = `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`;
    const options = { clawIconUrl };
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
