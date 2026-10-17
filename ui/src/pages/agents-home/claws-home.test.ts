/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { page as clawsRoute } from "../claws/route.ts";
import {
  cleanupAgentsHomePageTest,
  createPage,
  setupAgentsHomePageTest,
  workflowOperator,
} from "./agents-home-page.test-helpers.ts";
import { ClawsCatalogDialog } from "./claws-catalog-dialog.tsx";

beforeEach(setupAgentsHomePageTest);
afterEach(cleanupAgentsHomePageTest);

function createDetail(
  options: Parameters<typeof createPage>[0],
  initialEntry: typeof workflowOperator | null = workflowOperator,
) {
  const fixture = createPage(options);
  const [packageName, setPackageName] = createSignal<string>(workflowOperator.packageName);
  const view = mountSolid(
    () =>
      createComponent(ClawsCatalogDialog, {
        initialEntry,
        get initialPackageName() {
          return packageName();
        },
        pageMode: true,
      }),
    { wrapper: fixture.wrapper },
  );
  onTestFinished(view.unmount);
  return { ...fixture, detail: view.container, setPackageName };
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

  it.each(["/claws", "/claws/workflow-operator"])(
    "rejects direct visits to %s while Labs is disabled",
    async (pathname) => {
      const { context, page, request, ensureConfigLoaded } = createPage({ pathname });
      const location = { pathname, search: "", hash: "" };
      const result = await clawsRoute.loader!(context, {
        location,
        signal: new AbortController().signal,
        shouldRun: () => true,
        revalidating: false,
        cause: "navigation",
        deps: clawsRoute.loaderDeps!(context, location),
      });
      expect(result).toEqual({ type: "notFound", data: undefined });
      expect(ensureConfigLoaded).toHaveBeenCalledOnce();
      expect(page.textContent).toContain("Claws is disabled");
      expect(page.querySelector("[data-claws-explore]")).toBeNull();
      expect(page.querySelector("[data-claws-confirm]")).toBeNull();
      expect(request.mock.calls.some(([method]) => method.startsWith("claws."))).toBe(false);
    },
  );

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
    expect(page.querySelector(".catalog-page-header h1.page-title")?.textContent).toBe("Claws");
    expect(page.querySelector(".catalog-page-header [data-claws-search]")).not.toBeNull();
    expect(page.querySelector(".settings-page .catalog-page-header")).toBeNull();
    expect(page.querySelector(".agents-home__card")).toBeNull();
    expect(page.textContent).not.toContain("Manage agents");
    expect(request.mock.calls.some(([method]) => method === "sessions.list")).toBe(false);

    page.querySelector<HTMLButtonElement>(".agents-home__claw-card-link")?.click();
    expect(navigate).toHaveBeenCalledWith("claws", {
      pathname: "/claws/workflow-operator",
    });
    expect(request).toHaveBeenCalledWith("claws.catalog.search", {});
  });

  it("updates Explore results when the search changes", async () => {
    const { page, request } = createPage({ clawsEnabled: true });
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));

    const search = page.querySelector<HTMLInputElement>("[data-claws-explore] [data-claws-search]");
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

  it("clears a selected Claw when the detail route changes", async () => {
    const { detail, request, setPackageName } = createDetail({ clawsEnabled: true }, null);

    await vi.waitFor(() =>
      expect(detail.querySelector(".plugin-capabilities")?.textContent).toContain("AGENTS.md"),
    );
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
    const { detail, request, setPackageName } = createDetail(
      { clawsEnabled: true, applyWait },
      null,
    );

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
