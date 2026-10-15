/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupAgentsHomePageTest,
  createPage,
  setupAgentsHomePageTest,
  workflowOperator,
} from "./agents-home-page.test-helpers.ts";
import { ClawsCatalogDialog } from "./claws-catalog-dialog.tsx";

beforeEach(setupAgentsHomePageTest);
afterEach(cleanupAgentsHomePageTest);

describe("Claws on Agents Home", () => {
  it("shows official Claws and opens their dedicated route", async () => {
    const { page, navigate, request, ensureConfigLoaded } = createPage({ clawsEnabled: true });
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
    expect(ensureConfigLoaded).toHaveBeenCalledOnce();

    page.querySelector<HTMLButtonElement>(".agents-home__claw-card-link")?.click();
    expect(navigate).toHaveBeenCalledWith("claws", {
      pathname: "/agents/claws/workflow-operator",
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
    const { provider, request, navigate } = createPage({ clawsEnabled: true });
    const detail = new ClawsCatalogDialog.Element();
    detail.initialEntry = workflowOperator;
    detail.pageMode = true;
    provider.append(detail);

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
    const { provider, request } = createPage({ clawsEnabled: true });
    const detail = new ClawsCatalogDialog.Element();
    detail.pageMode = true;
    detail.initialPackageName = workflowOperator.packageName;
    provider.append(detail);

    await vi.waitFor(() =>
      expect(detail.querySelector(".plugin-capabilities")?.textContent).toContain("AGENTS.md"),
    );
    detail.initialPackageName = "@openclaw/another-claw";

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
    const { provider, request } = createPage({ clawsEnabled: true, applyWait });
    const detail = new ClawsCatalogDialog.Element();
    detail.pageMode = true;
    detail.initialPackageName = workflowOperator.packageName;
    provider.append(detail);

    await vi.waitFor(() =>
      expect(detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.disabled).toBe(
        false,
      ),
    );
    detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.click();
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([method]) => method === "claws.add.apply")).toBe(true),
    );

    detail.initialPackageName = "@openclaw/another-claw";
    await vi.waitFor(() => expect(detail.querySelector(".plugin-capabilities")).toBeNull());
    detail.initialPackageName = workflowOperator.packageName;
    await vi.waitFor(() =>
      expect(detail.querySelector<HTMLButtonElement>("[data-claws-confirm] button")?.disabled).toBe(
        false,
      ),
    );
    finishApply?.();
  });

  it("asks before acknowledging a ClawHub trust warning", async () => {
    const { provider, request, navigate } = createPage({
      clawsEnabled: true,
      riskConsentRequired: true,
      clawHubTrustWarning: "Review this release before adding it.",
    });
    const detail = new ClawsCatalogDialog.Element();
    detail.initialEntry = workflowOperator;
    detail.pageMode = true;
    provider.append(detail);

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
    const { provider, request, navigate } = createPage({
      clawsEnabled: true,
      reviewRequiredOnce: kind,
    });
    const detail = new ClawsCatalogDialog.Element();
    detail.initialEntry = workflowOperator;
    detail.pageMode = true;
    provider.append(detail);

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
    const { provider, request, navigate } = createPage({
      clawsEnabled: true,
      riskConsentRequired: true,
      reviewRequiredOnce: "plugin",
    });
    const detail = new ClawsCatalogDialog.Element();
    detail.initialEntry = workflowOperator;
    detail.pageMode = true;
    provider.append(detail);

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
