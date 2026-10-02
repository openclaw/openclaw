/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawUpdatePlan } from "./claw-lifecycle-client.ts";
import {
  auditUrl,
  auditWarning,
  cleanupClawLifecyclePanelTest,
  installed,
  mount,
  setupClawLifecyclePanelTest,
  updatePlan,
  updatePluginReview,
} from "./claw-lifecycle-panel.test-helpers.ts";

beforeEach(setupClawLifecyclePanelTest);
afterEach(cleanupClawLifecyclePanelTest);

describe("Agent Claw lifecycle", () => {
  it("allows read-only operators to preview Update without applying it", async () => {
    const { panel, request } = mount({ clawsEnabled: true, scopes: ["operator.read"] });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("After Update"));
    expect(request).toHaveBeenCalledWith("claws.update.plan", {
      agentId: "workflow",
      source: { packageName: "@openclaw/workflow-operator", version: "1.3.0" },
    });
    expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
      true,
    );
    expect(panel.textContent).toContain("An admin connection is required to update Claws.");
    panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.click();
    expect(request).not.toHaveBeenCalledWith("claws.update.apply", expect.anything());
  });

  it("reviews an exact official update and passes plugin grants to one apply call", async () => {
    const { panel, request } = mount({
      clawsEnabled: true,
      updatePlan: {
        ...updatePlan,
        actions: [
          ...updatePlan.actions,
          {
            kind: "mcpServer",
            id: "research",
            action: "add",
            blocked: false,
            effect: {
              type: "mcp-server",
              desiredDigest: "sha256:research-declaration",
              proposed: {
                transport: "stdio",
                command: "node",
                arguments: ["research-server.js", "--safe"],
                authentication: "none",
                environment: [{ name: "RESEARCH_TOKEN", sourceName: "RESEARCH_API_KEY" }],
              },
            },
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("workflow.start"));
    expect(panel.textContent).toContain(updatePluginReview.integrity);
    expect(panel.textContent).toContain("research-server.js");
    expect(panel.textContent).toContain("RESEARCH_TOKEN <- RESEARCH_API_KEY");
    expect(request).toHaveBeenCalledWith("claws.catalog.search", {
      query: "@openclaw/workflow-operator",
      limit: 100,
    });
    expect(request).toHaveBeenCalledWith("claws.catalog.detail", {
      packageName: "@openclaw/workflow-operator",
      version: "1.3.0",
    });
    expect(request).toHaveBeenCalledWith("claws.update.plan", {
      agentId: "workflow",
      source: { packageName: "@openclaw/workflow-operator", version: "1.3.0" },
    });
    expect(panel.textContent).toContain("Conversation access");
    expect(panel.textContent).toContain("Configured access");
    expect(panel.textContent).toContain("Current");
    expect(panel.textContent).toContain("After Update");
    expect(request).not.toHaveBeenCalledWith("claws.update.apply", expect.anything());

    panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.update.apply", {
        agentId: "workflow",
        source: { packageName: "@openclaw/workflow-operator", version: "1.3.0" },
        planIntegrity: "sha256:update-plan",
        acknowledgeCapabilities: [
          {
            actionId: "package:workflow-tools",
            pluginId: "workflow-tools",
            reviewToken: "review-workflow-tools-1.3.0",
            capabilityGrants: updatePluginReview.capabilityGrants,
            capabilityGrantsByPluginId: updatePluginReview.capabilityGrantsByPluginId,
          },
        ],
      }),
    );
    await vi.waitFor(() => expect(panel.textContent).toContain("Claw updated"));
    expect(request.mock.calls.filter(([method]) => method === "claws.update.apply")).toHaveLength(
      1,
    );
  });

  it("refuses an Update whose configured access cannot be disclosed", async () => {
    const { panel, request } = mount({
      clawsEnabled: true,
      updatePlan: { ...updatePlan, configuredAccess: undefined },
    });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() =>
      expect(panel.textContent).toContain("Access or schedule review is unavailable"),
    );
    expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
      true,
    );
    expect(request.mock.calls.some(([method]) => method === "claws.update.apply")).toBe(false);
  });

  it("refuses Update when an unblocked MCP change lacks its effect review", async () => {
    const { panel, request } = mount({
      clawsEnabled: true,
      updatePlan: {
        ...updatePlan,
        actions: [
          ...updatePlan.actions,
          { kind: "mcpServer", id: "research", action: "add", blocked: false },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
        true,
      ),
    );
    expect(panel.textContent).toContain("Effect review is incomplete");
    expect(request).not.toHaveBeenCalledWith("claws.update.apply", expect.anything());
  });

  it("requires separate ClawHub and plugin-risk acknowledgments on Update", async () => {
    const plan: ClawUpdatePlan = {
      ...updatePlan,
      trustWarning: "ClawHub requests review of this release.",
      riskAcknowledgementRequired: true,
      pluginReviews: [
        { ...updatePluginReview, riskWarning: "Plugin can access customer conversations." },
      ],
    };
    const { panel, request } = mount({ clawsEnabled: true, updatePlan: plan });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("customer conversations"));
    const confirm = panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]");
    expect(confirm?.disabled).toBe(true);
    panel.querySelector<HTMLInputElement>("[data-claw-plugin-risk]")?.click();
    await vi.waitFor(() => expect(confirm?.disabled).toBe(true));
    panel.querySelector<HTMLInputElement>(".claw-lifecycle-dialog__risk input")?.click();
    await vi.waitFor(() => expect(confirm?.disabled).toBe(false));
    confirm?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "claws.update.apply",
        expect.objectContaining({
          acknowledgeClawHubRisk: true,
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

  it("presents the ClawHub audit in the Update review without terminal borders", async () => {
    const plan: ClawUpdatePlan = {
      ...updatePlan,
      trustWarning: auditWarning,
      riskAcknowledgementRequired: true,
      pluginReviews: [{ ...updatePluginReview, riskWarning: auditWarning }],
    };
    const { panel, request } = mount({ clawsEnabled: true, updatePlan: plan });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() => expect(panel.querySelectorAll(".claws-trust-warning")).toHaveLength(2));

    for (const warning of panel.querySelectorAll<HTMLElement>(".claws-trust-warning")) {
      expect(warning.textContent).toContain("ClawHub Security Audit");
      expect(warning.textContent).toContain("Outcome: Review");
      expect(warning.textContent).toContain("Analysis pending");
      expect(warning.textContent).not.toMatch(/[╭╮│╰╯]/u);
      expect(warning.querySelector<HTMLAnchorElement>("a")?.href).toBe(auditUrl);
    }
    expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
      true,
    );
    expect(request.mock.calls.some(([method]) => method === "claws.update.apply")).toBe(false);
  });

  it("requires a warned skill receipt on Update", async () => {
    const plan: ClawUpdatePlan = {
      ...updatePlan,
      skillReviews: [
        {
          actionId: "skill:@community/triage",
          ref: "@community/triage",
          version: "2.0.0",
          integrity: "sha256:reviewed-skill",
          riskWarning: "This skill update needs review.",
          reviewToken: "sha256:skill-update-review",
        },
      ],
    };
    const { panel, request } = mount({ clawsEnabled: true, updatePlan: plan });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("This skill update needs review."));
    const confirm = panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]");
    expect(confirm?.disabled).toBe(true);
    panel.querySelector<HTMLInputElement>("[data-claw-skill-risk]")?.click();
    await vi.waitFor(() => expect(confirm?.disabled).toBe(false));
    confirm?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "claws.update.apply",
        expect.objectContaining({
          acknowledgeSkillWarnings: [
            {
              actionId: "skill:@community/triage",
              ref: "@community/triage",
              reviewToken: "sha256:skill-update-review",
              acknowledgeRiskWarning: true,
            },
          ],
        }),
      ),
    );
  });

  it("shows an up-to-date release without planning an Update", async () => {
    const { panel, request } = mount({ clawsEnabled: true, latestVersion: "1.2.0" });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("This Claw is up to date"));
    expect(panel.querySelector("[data-claw-update-confirm]")).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "claws.update.plan")).toBe(false);
  });

  it("hides Update for local Claws and disables an open review when Labs turns off", async () => {
    const local = mount({
      clawsEnabled: true,
      record: { ...installed, name: "local-workflow", sourceKind: "development" },
    });
    await vi.waitFor(() => expect(local.panel.textContent).toContain("local-workflow"));
    expect(local.panel.querySelector("[data-claw-update]")).toBeNull();

    const official = mount({ clawsEnabled: true });
    await vi.waitFor(() =>
      expect(official.panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(
        false,
      ),
    );
    official.panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() =>
      expect(
        official.panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled,
      ).toBe(false),
    );
    official.setClawsEnabled(false);
    await vi.waitFor(() =>
      expect(
        official.panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled,
      ).toBe(true),
    );
    expect(official.panel.textContent).toContain("Turn Claws on in Labs");
    official.panel.querySelector<HTMLButtonElement>(".claw-lifecycle-dialog__footer .btn")?.click();
    await vi.waitFor(() => expect(official.panel.querySelector("[data-claw-update]")).toBeNull());
    expect(
      official.panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.disabled,
    ).toBe(false);
    expect(official.request.mock.calls.some(([method]) => method === "claws.update.apply")).toBe(
      false,
    );
  });

  it("hides Update while the Labs config belongs to a prior Gateway", async () => {
    const { panel, request, markConfigStale } = mount({ clawsEnabled: true });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
        false,
      ),
    );

    markConfigStale();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
        true,
      ),
    );
    panel.querySelector<HTMLButtonElement>(".claw-lifecycle-dialog__footer .btn")?.click();
    await vi.waitFor(() => expect(panel.querySelector("[data-claw-update]")).toBeNull());
    expect(panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.disabled).toBe(
      false,
    );
    expect(request.mock.calls.some(([method]) => method === "claws.update.apply")).toBe(false);
  });

  it("keeps an ambiguous Update pending and never sends another apply", async () => {
    const { panel, request } = mount({ clawsEnabled: true, updateApplyError: true });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
        false,
      ),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Update outcome unknown"));
    expect(panel.querySelector("[data-claw-update-confirm]")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "claws.update.apply")).toHaveLength(
      1,
    );
    panel.querySelector<HTMLButtonElement>(".claw-lifecycle-dialog__footer .btn")?.click();
    await vi.waitFor(() => expect(panel.querySelector(".claw-lifecycle-dialog")).toBeNull());
    expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(true);
  });

  it("replans after a definite Update rejection without status reconciliation", async () => {
    const { panel, request } = mount({ clawsEnabled: true, updateRejectedOnce: true });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
        false,
      ),
    );
    const statusCallsBeforeApply = request.mock.calls.filter(
      ([method]) => method === "claws.status",
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Preview it again"));
    expect(panel.textContent).not.toContain("Update outcome unknown");
    expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
      true,
    );
    expect(request.mock.calls.filter(([method]) => method === "claws.status")).toHaveLength(
      statusCallsBeforeApply.length,
    );

    panel
      .querySelector<HTMLButtonElement>(".claw-lifecycle-dialog__body .callout.danger button")
      ?.click();
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "claws.update.plan")).toHaveLength(
        2,
      ),
    );
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
        false,
      ),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Claw updated"));
    expect(request.mock.calls.filter(([method]) => method === "claws.update.apply")).toHaveLength(
      2,
    );
  });

  it("reconciles a timed-out Update from status without sending another apply", async () => {
    const { panel, request } = mount({
      clawsEnabled: true,
      updateApplyError: true,
      updateAppliedBeforeError: true,
    });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
        false,
      ),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Claw updated"));
    expect(panel.textContent).not.toContain("Update outcome unknown");
    expect(request.mock.calls.filter(([method]) => method === "claws.update.apply")).toHaveLength(
      1,
    );
  });

  it("keeps an ambiguous Update unknown when status belongs to another Claw", async () => {
    const { panel, request } = mount({
      clawsEnabled: true,
      updateApplyError: true,
      updateAppliedBeforeError: true,
      updateAppliedRecord: { name: "@openclaw/other-claw" },
    });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
        false,
      ),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Update outcome unknown"));
    expect(panel.textContent).not.toContain("Claw updated");
    expect(request.mock.calls.filter(([method]) => method === "claws.update.apply")).toHaveLength(
      1,
    );
  });
});
