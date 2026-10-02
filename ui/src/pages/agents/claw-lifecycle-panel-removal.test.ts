/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleLitElement } from "../../test-helpers/lit-settle.ts";
import {
  cleanupClawLifecyclePanelTest,
  installed,
  mount,
  removePlan,
  setupClawLifecyclePanelTest,
} from "./claw-lifecycle-panel.test-helpers.ts";

beforeEach(setupClawLifecyclePanelTest);
afterEach(cleanupClawLifecyclePanelTest);

describe("Agent Claw lifecycle", () => {
  it("allows reviewed removal with retained files while Labs is off", async () => {
    const { panel, request, navigate } = mount({
      plan: {
        ...removePlan,
        actions: [
          ...removePlan.actions,
          {
            kind: "mcpServer",
            id: "shared-search",
            action: "release",
            blocked: false,
            effect: {
              type: "mcp-server",
              currentDigest: "sha256:installed-search",
              ownership: {
                relationship: "referenced",
                origin: "pre-existing",
                independentOwner: true,
                affectedClawCount: 2,
              },
            },
          },
          { kind: "cronJob", id: "daily", action: "remove", blocked: false },
          { kind: "workspaceFile", id: "AGENTS.md", action: "retain", blocked: false },
          { kind: "bootstrap", id: "BOOTSTRAP.md", action: "retain", blocked: false },
        ],
        scheduledJobs: {
          coverage: "package-declarations",
          jobs: [
            {
              id: "daily",
              action: "remove",
              blocked: false,
              current: {
                schedule: { cron: "0 8 * * *", timezone: "UTC" },
                session: "isolated",
                delivery: "none",
                messageDigest: "sha256:current-private-task",
              },
            },
          ],
        },
      },
    });
    await vi.waitFor(() => expect(panel.textContent).toContain("@openclaw/workflow-operator"));
    expect(request).toHaveBeenCalledWith("claws.status", { target: "workflow" });
    expect(panel.textContent).toContain("workflow-tools");
    expect(panel.textContent).toContain("Referenced");
    expect(panel.textContent).toContain("Shared");
    expect(panel.querySelector("[data-claw-update]")).toBeNull();

    panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector("[data-claw-remove-confirm]")).not.toBeNull(),
    );
    expect(panel.textContent).toContain("Kept");
    expect(panel.textContent).toContain("shared-search");
    expect(panel.textContent).toMatch(/Other Claws\s+2/u);
    expect(panel.textContent).toContain("sha256:current-private-task");
    expect(panel.textContent).toContain(
      "Some resources may stay installed even when no other Claw uses them.",
    );
    expect(panel.textContent).not.toContain("Release plugin reference");
    expect(request).not.toHaveBeenCalledWith("claws.remove.apply", expect.anything());

    panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.remove.apply", {
        agentId: "workflow",
        planIntegrity: "sha256:remove-plan",
      }),
    );
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("agents"));
  });

  it("explains that releasing a Claw-introduced plugin keeps it installed", async () => {
    const { panel } = mount({
      plan: {
        ...removePlan,
        actions: [
          ...removePlan.actions,
          {
            kind: "packageRef",
            id: "plugin:@openclaw/lobster@2026.9.7",
            action: "release",
            blocked: false,
            effect: {
              type: "ownership",
              relationship: "referenced",
              origin: "claw-introduced",
              independentOwner: false,
              affectedClawCount: 0,
            },
          },
        ],
      },
    });
    await vi.waitFor(() => expect(panel.textContent).toContain(installed.name));
    panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
        false,
      ),
    );
    expect(panel.textContent).toContain("Release plugin reference");
    expect(panel.textContent).toContain("the plugin remains installed");
    expect(panel.textContent).toContain("in Plugins or with the CLI");
  });

  it("does not call apply for a blocked removal plan", async () => {
    const blocked = {
      ...removePlan,
      blockers: [{ code: "shared_agent", path: "resources.agent", message: "Agent is shared" }],
    };
    const { panel, request } = mount({ plan: blocked });
    await vi.waitFor(() => expect(panel.textContent).toContain(installed.name));
    panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Agent is shared"));
    expect(panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
      true,
    );
    expect(request.mock.calls.some(([method]) => method === "claws.remove.apply")).toBe(false);
  });

  it("refuses Remove when an unblocked resource has no exact effect review", async () => {
    const { panel, request } = mount({
      plan: {
        ...removePlan,
        actions: [
          ...removePlan.actions,
          {
            kind: "packageRef",
            id: "plugin:@openclaw/search@1.0.0",
            action: "release",
            blocked: false,
          },
        ],
      },
    });
    await vi.waitFor(() => expect(panel.textContent).toContain(installed.name));
    panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
        true,
      ),
    );
    expect(panel.textContent).toContain("Effect review is incomplete");
    expect(request).not.toHaveBeenCalledWith("claws.remove.apply", expect.anything());
  });

  it("keeps an ambiguous removal pending and never sends a second apply", async () => {
    const { panel, request, navigate } = mount({ applyError: true });
    await vi.waitFor(() => expect(panel.textContent).toContain(installed.name));
    panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector("[data-claw-remove-confirm]")).not.toBeNull(),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Removal outcome unknown"));
    expect(panel.querySelector("[data-claw-remove-confirm]")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "claws.remove.apply")).toHaveLength(
      1,
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps a timed-out removal unknown when status vanished but the agent remains", async () => {
    const { panel, request, navigate } = mount({
      applyError: true,
      removeAppliedBeforeError: true,
      agentStillInRoster: true,
    });
    await vi.waitFor(() => expect(panel.textContent).toContain(installed.name));
    panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
        false,
      ),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();

    await vi.waitFor(() => expect(panel.textContent).toContain("Removal outcome unknown"));
    expect(navigate).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([method]) => method === "claws.remove.apply")).toHaveLength(
      1,
    );
  });

  it("settles a timed-out adopted removal when its Claw record disappears", async () => {
    const { panel, request, navigate } = mount({
      record: {
        ...installed,
        resources: [
          {
            kind: "agent",
            id: "workflow",
            state: "present",
            relationship: "managed",
            origin: "pre-existing",
            independentOwner: true,
          },
        ],
      },
      plan: {
        ...removePlan,
        actions: [
          { kind: "agent", id: "workflow", action: "retain", blocked: false },
          ...removePlan.actions.slice(1),
        ],
      },
      applyError: true,
      removeAppliedBeforeError: true,
      agentStillInRoster: true,
    });
    await vi.waitFor(() => expect(panel.textContent).toContain(installed.name));
    panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
        false,
      ),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("agents"));
    expect(request.mock.calls.filter(([method]) => method === "claws.remove.apply")).toHaveLength(
      1,
    );
    expect(panel.textContent).not.toContain("Removal outcome unknown");
  });

  it("replans after a definite Remove rejection without status reconciliation", async () => {
    const { panel, request, navigate } = mount({ removeRejectedOnce: true });
    await vi.waitFor(() => expect(panel.textContent).toContain(installed.name));
    panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
        false,
      ),
    );
    const statusCallsBeforeApply = request.mock.calls.filter(
      ([method]) => method === "claws.status",
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Preview it again"));
    expect(panel.textContent).not.toContain("Removal outcome unknown");
    expect(panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
      true,
    );
    expect(request.mock.calls.filter(([method]) => method === "claws.status")).toHaveLength(
      statusCallsBeforeApply.length,
    );

    panel
      .querySelector<HTMLButtonElement>(".claw-lifecycle-dialog__body .callout.danger button")
      ?.click();
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "claws.remove.plan")).toHaveLength(
        2,
      ),
    );
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
        false,
      ),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("agents"));
    expect(request.mock.calls.filter(([method]) => method === "claws.remove.apply")).toHaveLength(
      2,
    );
  });

  it("requires a fresh status read before replanning a partial removal", async () => {
    const { panel, request } = mount({
      applyResult: { agentId: "workflow", status: "partial", agentRemoved: false },
    });
    await vi.waitFor(() => expect(panel.textContent).toContain(installed.name));
    panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector("[data-claw-remove-confirm]")).not.toBeNull(),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Removal incomplete"));
    panel.querySelector<HTMLButtonElement>(".claw-lifecycle-dialog__footer .btn")?.click();
    await vi.waitFor(() => expect(panel.querySelector(".claw-lifecycle-dialog")).toBeNull());
    expect(panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.disabled).toBe(
      true,
    );

    panel.querySelector<HTMLButtonElement>(".settings-section__actions .btn")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.disabled).toBe(
        false,
      ),
    );
    expect(request.mock.calls.filter(([method]) => method === "claws.remove.apply")).toHaveLength(
      1,
    );
  });

  it("does not add a Claw section to an ordinary agent", async () => {
    const { panel, request } = mount({ record: null });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.status", { target: "workflow" }),
    );
    await settleLitElement(panel);
    expect(panel.textContent).toBe("");
  });
});
