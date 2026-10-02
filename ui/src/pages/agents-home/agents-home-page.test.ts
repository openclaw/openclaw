/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditUrl,
  auditWarning,
  cleanupAgentsHomePageTest,
  createPage,
  elementName,
  setupAgentsHomePageTest,
  workflowOperator,
  workflowPluginReview,
} from "./agents-home-page.test-helpers.ts";
import { AgentsHomePage } from "./agents-home-page.ts";
import type { ClawCatalogEntry } from "./claws-catalog-client.ts";
import { ClawsExplore } from "./claws-explore.ts";
import { pluginAcknowledgements } from "./claws-plugin-review.ts";

beforeEach(setupAgentsHomePageTest);
afterEach(cleanupAgentsHomePageTest);

describe("AgentsHomePage", () => {
  it("shows official Explore cards and search beside the installed roster only with Labs on", async () => {
    const { page, request, setClawsEnabled } = createPage();
    await vi.waitFor(() => expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2));
    expect(page.querySelector("[data-claws-explore]")).toBeNull();
    expect(page.querySelector("[data-claws-open-catalog]")).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "claws.catalog.search")).toBe(false);

    setClawsEnabled(true);
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
    expect(page.querySelector("[data-claws-open-catalog]")).not.toBeNull();
    expect(page.querySelector("openclaw-claws-catalog-dialog")).toBeNull();
    expect(page.querySelector("[data-claws-explore]")?.textContent).toContain("Explore Claws");
    expect(page.querySelector("[data-claws-entry]")?.textContent).toContain("Workflow Operator");
    expect(page.querySelector("[data-claws-entry]")?.textContent).toContain("Runs approved work");
    expect(page.querySelector("[data-claws-entry]")?.textContent).toContain("Version 1.2.0");
    expect(page.querySelector("[data-claws-entry]")?.textContent).toContain("12 downloads");
    expect(request).toHaveBeenCalledWith("claws.catalog.search", {});

    const search = page.querySelector<HTMLInputElement>("[data-claws-search]");
    expect(search).not.toBeNull();
    search!.value = "no match";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.catalog.search", { query: "no match" }),
    );
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(0));
    expect(page.querySelector("[data-claws-explore]")?.textContent).toContain("No Claws found");
    search!.value = "workflow";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.catalog.search", { query: "workflow" }),
    );
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    expect(page.querySelector(".claws-catalog__list")).toBeNull();
    setClawsEnabled(false);
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).toBeNull());
    expect(page.querySelector("[data-claws-open-catalog]")).toBeNull();
    expect(page.querySelector("[data-claws-confirm]")).toBeNull();
    expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2);
    setClawsEnabled(true);
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
    expect(page.querySelector("openclaw-claws-catalog-dialog")).toBeNull();
  });

  it("hides Explore and closes its review while the Labs config belongs to a prior Gateway", async () => {
    const { page, markConfigStale } = createPage({ clawsEnabled: true });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());

    markConfigStale();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).toBeNull());
    expect(page.querySelector("[data-claws-open-catalog]")).toBeNull();
    expect(page.querySelector("[data-claws-confirm]")).toBeNull();
    expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2);
  });

  it("opens the searchable catalog from the header and keeps the installed roster", async () => {
    const { page, request } = createPage({ clawsEnabled: true });
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
    const trigger = page.querySelector<HTMLButtonElement>("[data-claws-open-catalog]");
    expect(trigger?.getAttribute("aria-label")).toBe("Search Claws");
    expect(trigger?.getAttribute("aria-haspopup")).toBe("dialog");
    trigger?.click();

    await vi.waitFor(() => expect(page.querySelector(".claws-catalog__list")).not.toBeNull());
    expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2);
    const search = page.querySelector<HTMLInputElement>(
      "openclaw-claws-catalog-dialog [data-claws-search]",
    );
    expect(search?.hasAttribute("autofocus")).toBe(true);
    search!.value = "workflow";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.catalog.search", { query: "workflow" }),
    );
    page.querySelector<HTMLElement>(".claws-catalog__close")?.click();
    await vi.waitFor(() => expect(page.querySelector("openclaw-claws-catalog-dialog")).toBeNull());
    expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1);
  });

  it("returns from a selected review to the inline Explore cards", async () => {
    const { page, request } = createPage({ clawsEnabled: true });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    expect(page.querySelector(".claws-catalog__list")).toBeNull();
    page.querySelector<HTMLElement>(".claws-catalog__back")?.click();
    await vi.waitFor(() => expect(page.querySelector("openclaw-claws-catalog-dialog")).toBeNull());
    expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1);
    expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "claws.catalog.search")).toHaveLength(
      1,
    );
  });

  it("does not replace a newer search with an older catalog response", async () => {
    const loads = vi.spyOn(
      ClawsExplore.prototype as unknown as { loadCatalog: () => Promise<void> },
      "loadCatalog",
    );
    let resolveInitial!: (value: { entries: ClawCatalogEntry[] }) => void;
    const initialSearch = new Promise<{ entries: ClawCatalogEntry[] }>((resolve) => {
      resolveInitial = resolve;
    });
    try {
      const { page, request } = createPage({
        clawsEnabled: true,
        catalogSearch: (query) =>
          query ? Promise.resolve({ entries: [workflowOperator] }) : initialSearch,
      });
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("claws.catalog.search", {}));
      const initialLoad = loads.mock.results[0]?.value;
      expect(initialLoad).toBeDefined();
      const search = page.querySelector<HTMLInputElement>("[data-claws-search]");
      expect(search).not.toBeNull();
      search!.value = "workflow";
      search!.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
      resolveInitial({ entries: [{ ...workflowOperator, displayName: "Stale result" }] });
      await initialLoad;
      await page.querySelector<ClawsExplore>("openclaw-claws-explore")?.updateComplete;
      expect(page.querySelector("[data-claws-entry]")?.textContent).toContain("Workflow Operator");
      expect(page.textContent).not.toContain("Stale result");
    } finally {
      loads.mockRestore();
    }
  });

  it("reviews a plugin-bearing Claw before Add and opens its home chat when ready", async () => {
    const { page, request, navigate, agentSelection, gateway } = createPage({
      clawsEnabled: true,
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] ")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("workflow-tools"));
    expect(page.textContent).toContain("create workspace");
    expect(page.textContent).toContain("install package");
    expect(page.textContent).toContain("workflow.start");
    expect(page.textContent).toContain(workflowPluginReview.integrity);
    expect(page.textContent).toContain("Conversation access");
    expect(page.textContent).toContain("Allowed");
    expect(page.textContent).toContain("Configured access");
    expect(page.textContent).toContain("sessions_spawn");
    expect(page.textContent).toContain("No scheduled jobs declared");
    expect(request).toHaveBeenCalledWith("claws.catalog.detail", {
      packageName: "@openclaw/workflow-operator",
      version: "1.2.0",
    });
    expect(request).toHaveBeenCalledWith("claws.add.plan", {
      source: { packageName: "@openclaw/workflow-operator", version: "1.2.0" },
    });
    expect(request).not.toHaveBeenCalledWith("claws.add.apply", expect.anything());

    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.add.apply", {
        source: { packageName: "@openclaw/workflow-operator", version: "1.2.0" },
        planIntegrity: "sha256:reviewed-plan",
        acknowledgeCapabilities: [
          {
            actionId: "plugin:@openclaw/workflow-tools",
            pluginId: "workflow-tools",
            reviewToken: "review-workflow-tools",
            capabilityGrants: workflowPluginReview.capabilityGrants,
            capabilityGrantsByPluginId: workflowPluginReview.capabilityGrantsByPluginId,
          },
        ],
      }),
    );
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("chat", { pathname: "/chat/workflow-operator" }),
    );
    expect(agentSelection.state.selectedId).toBe("workflow-operator");
    expect(gateway.setSessionKey).toHaveBeenCalledWith("agent:workflow-operator:team-room");
  });

  it("does not acknowledge a plugin review without artifact integrity", () => {
    expect(
      pluginAcknowledgements([{ ...workflowPluginReview, integrity: "" }], new Set()),
    ).toBeNull();
    expect(
      pluginAcknowledgements(
        [{ ...workflowPluginReview, ownerAction: "reuse", integrity: "" }],
        new Set(),
      ),
    ).toBeNull();
  });

  it("requires explicit acknowledgment of plugin risk before applying the reviewed grant", async () => {
    const { page, request } = createPage({
      clawsEnabled: true,
      pluginRiskWarning: "This plugin can access customer conversations.",
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("customer conversations"));
    expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(true);
    page.querySelector<HTMLInputElement>("[data-claw-plugin-risk]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(false),
    );
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "claws.add.apply",
        expect.objectContaining({
          acknowledgeCapabilities: [
            expect.objectContaining({
              pluginId: "workflow-tools",
              acknowledgeRiskWarning: true,
            }),
          ],
        }),
      ),
    );
  });

  it("presents the ClawHub audit in the Add review without terminal borders", async () => {
    const { page, request } = createPage({
      clawsEnabled: true,
      pluginRiskWarning: auditWarning,
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector(".claws-plugin-review__entry .claws-trust-warning")).not.toBeNull(),
    );

    const warning = page.querySelector<HTMLElement>(
      ".claws-plugin-review__entry .claws-trust-warning",
    );
    expect(warning?.textContent).toContain("ClawHub Security Audit");
    expect(warning?.textContent).toContain("Outcome: Review");
    expect(warning?.textContent).toContain("Analysis pending");
    expect(warning?.textContent).not.toMatch(/[╭╮│╰╯]/u);
    expect(warning?.querySelector<HTMLAnchorElement>("a")?.href).toBe(auditUrl);
    expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(true);
    expect(request.mock.calls.some(([method]) => method === "claws.add.apply")).toBe(false);
  });

  it("does not link to a non-HTTP audit destination", async () => {
    const { page } = createPage({
      clawsEnabled: true,
      pluginRiskWarning: auditWarning.replace(auditUrl, "javascript:alert(1)"),
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector(".claws-trust-warning")).not.toBeNull());

    const warning = page.querySelector<HTMLElement>(".claws-trust-warning");
    expect(warning?.textContent).toContain("javascript:alert(1)");
    expect(warning?.querySelector("a")).toBeNull();
    expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(true);
  });

  it("requires explicit review of a warned skill before Add", async () => {
    const { page, request } = createPage({
      clawsEnabled: true,
      skillRiskWarning: "This community skill needs review.",
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() =>
      expect(page.textContent).toContain("This community skill needs review."),
    );
    expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(true);
    page.querySelector<HTMLInputElement>("[data-claw-skill-risk]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(false),
    );
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "claws.add.apply",
        expect.objectContaining({
          acknowledgeSkillWarnings: [
            {
              actionId: "skill:@community/triage",
              ref: "@community/triage",
              reviewToken: "sha256:skill-review",
              acknowledgeRiskWarning: true,
            },
          ],
        }),
      ),
    );
  });

  it("shows a reused plugin without sending installer capability consent", async () => {
    const { page, request } = createPage({ clawsEnabled: true, reusePlugin: true });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Already installed"));
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.add.apply", {
        source: { packageName: "@openclaw/workflow-operator", version: "1.2.0" },
        planIntegrity: "sha256:reviewed-plan",
      }),
    );
  });

  it("does not offer Add when the Gateway omits the plugin review", async () => {
    const { page, request } = createPage({ clawsEnabled: true, missingPluginReview: true });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Plugin review is unavailable"));
    expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(true);
    expect(request.mock.calls.some(([method]) => method === "claws.add.apply")).toBe(false);
  });

  it("does not offer Add when configured access or schedule review is missing", async () => {
    const { page, request } = createPage({ clawsEnabled: true, missingDisclosure: true });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Access or schedule review is unavailable"),
    );
    expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(true);
    expect(request.mock.calls.some(([method]) => method === "claws.add.apply")).toBe(false);
  });

  it("refuses a truncated configured-access review", async () => {
    const { page, request } = createPage({ clawsEnabled: true, malformedDisclosure: true });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Access or schedule review is unavailable"),
    );
    expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(true);
    expect(request.mock.calls.some(([method]) => method === "claws.add.apply")).toBe(false);
  });

  it("does not reapply a completed Claw while its agent is absent from the refreshed roster", async () => {
    const { page, request, navigate } = createPage({
      clawsEnabled: true,
      newAgentVisible: false,
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Claw added"));
    expect(page.textContent).toContain("Open it from Agents");
    expect(page.querySelector("[data-claws-confirm]")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps a known Add result when roster refresh fails", async () => {
    const { page, request, navigate } = createPage({
      clawsEnabled: true,
      rosterErrorAfterAdd: true,
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Claw added"));
    expect(page.textContent).not.toContain("Add outcome unknown");
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("checks status after an ambiguous Add and never offers a second Add", async () => {
    const { page, request, navigate } = createPage({ clawsEnabled: true, applyError: true });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Add outcome unknown"));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.status", { target: "workflow-operator" }),
    );
    expect(page.querySelector("[data-claws-confirm]")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("replans after a definite Add rejection without treating it as an unknown outcome", async () => {
    const { page, request, navigate } = createPage({
      clawsEnabled: true,
      applyRejectedOnce: true,
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(false),
    );
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Preview it again"));
    expect(page.textContent).not.toContain("Add outcome unknown");
    expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(true);
    expect(request).not.toHaveBeenCalledWith("claws.status", { target: "workflow-operator" });

    page.querySelector<HTMLElement>(".claws-catalog__review .callout.danger button")?.click();
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "claws.add.plan")).toHaveLength(2),
    );
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(false),
    );
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("chat", { pathname: "/chat/workflow-operator" }),
    );
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(2);
  });

  it("reconciles a timed-out Add from Claws status without retrying installation", async () => {
    const { page, request, navigate } = createPage({
      clawsEnabled: true,
      applyError: true,
      statusRecord: { agentId: "workflow-operator", version: "1.2.0", status: "complete" },
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Claw added"));
    expect(page.querySelector("[data-claws-confirm]")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous Add unknown when status belongs to another Claw", async () => {
    const { page, request, navigate } = createPage({
      clawsEnabled: true,
      applyError: true,
      statusRecord: {
        agentId: "workflow-operator",
        name: "@openclaw/other-claw",
        version: "1.2.0",
        status: "complete",
      },
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.status", { target: "workflow-operator" }),
    );
    await vi.waitFor(() =>
      expect(
        page.querySelector(".claws-catalog__review .callout.warn button")?.textContent?.trim(),
      ).toBe("Check status"),
    );
    expect(page.textContent).toContain("Add outcome unknown");
    expect(page.textContent).not.toContain("Claw added");
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens an installed Claw's home chat after Add when it needs setup", async () => {
    const { page, request, navigate, agentSelection, gateway } = createPage({
      clawsEnabled: true,
      applyResult: {
        agentId: "workflow-operator",
        status: "complete",
        readiness: { ready: false, requirements: [{ kind: "oauth", owner: "workflows" }] },
      },
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("chat", { pathname: "/chat/workflow-operator" }),
    );
    expect(request).toHaveBeenCalledWith("claws.status", { target: "workflow-operator" });
    expect(agentSelection.state.selectedId).toBe("workflow-operator");
    expect(gateway.setSessionKey).toHaveBeenCalledWith("agent:workflow-operator:team-room");
    expect(page.querySelector("openclaw-claws-catalog-dialog")).toBeNull();
  });

  const confirmedStatus = { agentId: "workflow-operator", version: "1.2.0", status: "complete" };
  const safeAddOutcomes: Array<[string, Parameters<typeof createPage>[0], string]> = [
    [
      "the agent is missing",
      {
        applyResult: {
          agentId: "workflow-operator",
          status: "complete",
          readiness: { ready: false, requirements: [{ kind: "oauth", owner: "workflows" }] },
        },
        statusRecord: { ...confirmedStatus, agentState: "missing" },
      },
      "Needs setup",
    ],
    [
      "Add is partial",
      {
        applyResult: {
          agentId: "workflow-operator",
          status: "partial",
          readiness: { ready: false },
          error: { code: "plugin_install_failed", message: "Plugin installation failed" },
        },
      },
      "Check Claws status",
    ],
    ["the status read fails", { statusErrorAfterAdd: true }, "Claw added"],
    [
      "the status record is stale",
      { statusRecord: { ...confirmedStatus, version: "1.1.0", agentState: "present" } },
      "Claw added",
    ],
    [
      "the status belongs to another Claw",
      { statusRecord: { ...confirmedStatus, name: "@openclaw/other-claw" } },
      "Claw added",
    ],
  ];

  it.each(safeAddOutcomes)("stays in review: %s", async (_condition, options, message) => {
    const { page, navigate, agentSelection } = createPage({
      clawsEnabled: true,
      ...options,
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() => expect(page.querySelectorAll(".agents-home__card")).toHaveLength(3));
    await vi.waitFor(() => {
      const done = page.querySelector<HTMLButtonElement>(".claws-catalog__footer button");
      expect(done?.textContent?.trim()).toBe("Done");
      expect(done?.disabled).toBe(false);
    });
    expect(page.textContent).toContain(message);
    expect(page.textContent).not.toContain("Add outcome unknown");
    expect(page.querySelector("[data-claws-confirm]")).toBeNull();
    expect(agentSelection.state.selectedId).toBe("harbor");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows the configured roster, prioritizes work across sessions, and opens the canonical main chat", async () => {
    const { page, request, navigate } = createPage();
    await vi.waitFor(() => expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2));

    const cards = [...page.querySelectorAll(".agents-home__card")];
    expect(cards.map((card) => card.querySelector("h2")?.textContent)).toEqual(["Ember", "Harbor"]);
    expect(cards[0]?.textContent).toContain("Builds small tools");
    expect(cards[0]?.textContent).toContain("example/model-small");
    await vi.waitFor(() =>
      expect(cards[0]?.querySelector(".identity-avatar__agent-face")).not.toBeNull(),
    );
    expect(cards[1]?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe(
      "⚓",
    );
    expect(cards[0]?.querySelector(".agents-home__working")?.textContent).toBe("Working now");
    expect(cards[1]?.querySelector(".agents-home__working")).toBeNull();
    expect(cards[0]?.querySelector(".agents-home__preview")?.textContent?.trim()).toBe(
      "The main chat summary.",
    );
    expect(page.textContent).not.toContain("System helper");
    expect(page.textContent).not.toContain("A newer side-task message.");
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ includeLastMessage: true, archived: "all", limit: 100 }),
    );

    const openChat = cards[0]?.querySelector<HTMLElement>(".agents-home__open");
    expect(openChat?.textContent).toBe("Open chat");
    openChat?.click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/ember" });
  });

  it("shares bounded activity loading between consumers and stops after the last detach", async () => {
    vi.useFakeTimers();
    const { page, provider, request, rosterListenerCount, updateSessions, emitChange } =
      createPage();
    await vi.waitFor(() => expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2));
    const second = new (customElements.get(elementName) ?? AgentsHomePage)();
    provider.append(second);
    await vi.waitFor(() => expect(second.querySelectorAll(".agents-home__card")).toHaveLength(2));
    const calls = (method: string) =>
      request.mock.calls.filter(
        ([name, params]) =>
          name === method &&
          (method !== "sessions.list" ||
            (params !== null &&
              typeof params === "object" &&
              "archived" in params &&
              params.archived === "all")),
      );
    expect(calls("sessions.subscribe")).toHaveLength(0);
    expect(calls("sessions.list")).toHaveLength(1);
    expect(rosterListenerCount()).toBe(0);

    updateSessions(
      Array.from({ length: 301 }, (_, index) => ({
        key: `agent:harbor:task-${index}`,
        kind: "direct",
        updatedAt: index + 1,
        lastMessagePreview: `Activity ${index}`,
      })),
    );
    request.mockClear();
    emitChange();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(page.textContent).toContain("Activity 299");
    expect(second.textContent).toContain("Activity 299");
    expect(calls("sessions.list")).toHaveLength(3);
    expect(calls("sessions.subscribe")).toHaveLength(0);
    expect(page.textContent).not.toContain("Activity 300");

    page.remove();
    expect(rosterListenerCount()).toBe(0);
    request.mockClear();
    emitChange();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls("sessions.list")).toHaveLength(3);
    emitChange();
    second.remove();
    expect(rosterListenerCount()).toBe(0);
    request.mockClear();
    emitChange();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls("sessions.list")).toHaveLength(0);
  });

  it("refreshes live status and previews after session events and gateway reconnect", async () => {
    vi.useFakeTimers();
    const { page, updateSessions, emitChange, setPhase } = createPage();
    await vi.waitFor(() => expect(page.querySelector(".agents-home__working")).not.toBeNull());
    updateSessions([
      {
        key: "agent:ember:team-room",
        agentId: "ember",
        kind: "direct",
        isMain: true,
        updatedAt: 7_000,
        lastMessagePreview: "The tool is finished.",
      },
    ]);
    emitChange();
    emitChange();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(page.textContent).toContain("The tool is finished."));
    expect(page.querySelector(".agents-home__working")).toBeNull();

    setPhase("reconnecting");
    await vi.waitFor(() => expect(page.textContent).toContain("Connect to the Gateway"));
    updateSessions([
      {
        key: "agent:harbor:team-room",
        agentId: "harbor",
        kind: "direct",
        isMain: true,
        updatedAt: 8_000,
        lastMessagePreview: "The next schedule is ready.",
        hasActiveRun: true,
      },
    ]);
    setPhase("connected");
    await vi.waitFor(() => expect(page.textContent).toContain("The next schedule is ready."));
    expect(page.querySelector(".agents-home__card h2")?.textContent).toBe("Harbor");
    expect(page.querySelector(".agents-home__working")?.textContent).toBe("Working now");
  });
});
