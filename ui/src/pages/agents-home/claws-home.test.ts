/* @vitest-environment jsdom */

import { getQueriesForElement } from "@solidjs/testing-library";
import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { pathForClawCatalogEntry } from "../../app-route-paths.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
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
