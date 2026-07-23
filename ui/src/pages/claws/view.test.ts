/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClawCatalogDetail,
  ClawLifecyclePlanResult,
  ClawsDoctorResult,
  ClawsStatusResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { i18n } from "../../i18n/index.ts";
import { renderClaws } from "./view.ts";

const status: ClawsStatusResult = {
  schemaVersion: "openclaw.clawsGatewayStatus.v1",
  records: [
    {
      agentId: "analyst",
      name: "financial-analyst",
      version: "1.2.0",
      sourceKind: "package",
      status: "complete",
      agentState: "present",
      orphaned: false,
      addedAtMs: 1_000,
      updatedAtMs: 2_000,
      resources: [
        {
          kind: "plugin",
          id: "@openclaw/markets@2.0.0",
          state: "present",
          relationship: "referenced",
          origin: "pre-existing",
          independentOwner: true,
        },
      ],
    },
  ],
  summary: { claws: 1, healthy: 1, attention: 0, managed: 0, referenced: 1 },
};

const doctor: ClawsDoctorResult = {
  schemaVersion: "openclaw.clawsGatewayDoctor.v1",
  findings: [],
  summary: { info: 0, warnings: 0, errors: 0 },
};

const catalogDetail: ClawCatalogDetail = {
  packageName: "financial-analyst",
  displayName: "Financial Analyst",
  summary: "Market research and reporting.",
  channel: "official",
  official: true,
  version: "1.3.0",
  workspaceFiles: 2,
  skills: 1,
  plugins: 1,
  mcpServers: 1,
  scheduledJobs: 1,
};

const plan: ClawLifecyclePlanResult = {
  schemaVersion: "openclaw.clawsGatewayPlan.v1",
  operation: "update",
  planIntegrity: "sha256:preview",
  target: { agentId: "analyst", name: "financial-analyst", targetVersion: "1.3.0" },
  actions: [{ kind: "workspace-file", id: "SOUL.md", action: "update", blocked: false }],
  capabilities: [
    { kind: "plugin", id: "@openclaw/markets", action: "install", reason: "Required" },
  ],
  blockers: [],
  trustWarning: "This release needs review.",
  riskAcknowledgementRequired: true,
};

function props(overrides: Partial<Parameters<typeof renderClaws>[0]> = {}) {
  return {
    connected: true,
    available: true,
    catalogAvailable: true,
    lifecycleAvailable: true,
    loading: false,
    operationBusy: false,
    error: null,
    status,
    doctor,
    selectedAgentId: "analyst",
    mode: "installed" as const,
    query: "",
    catalogEntries: [],
    catalogDetail: null,
    plan: null,
    outcome: null,
    removeUnused: false,
    riskAcknowledged: false,
    onSelect: vi.fn(),
    onModeChange: vi.fn(),
    onQueryChange: vi.fn(),
    onSearch: vi.fn(),
    onSelectCatalog: vi.fn(),
    onPreviewAdd: vi.fn(),
    onPreviewUpdate: vi.fn(),
    onPreviewRemove: vi.fn(),
    onRemoveUnusedChange: vi.fn(),
    onRiskAcknowledgedChange: vi.fn(),
    onCancelPlan: vi.fn(),
    onApplyPlan: vi.fn(),
    ...overrides,
  };
}

describe("renderClaws", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
  });

  it("renders inventory, provenance, and lifecycle health", () => {
    const container = document.createElement("div");
    render(renderClaws(props()), container);

    expect(container.querySelector(".claws-inventory__name")?.textContent).toBe(
      "financial-analyst",
    );
    expect(container.querySelector(".claws-resource__id")?.textContent).toContain(
      "@openclaw/markets@2.0.0",
    );
    expect(container.textContent).toContain("Referenced");
    expect(container.textContent).toContain("Pre-existing");
    expect(container.textContent).toContain("Healthy");
  });

  it("does not render lifecycle state when the method is unavailable", () => {
    const container = document.createElement("div");
    render(renderClaws(props({ available: false })), container);

    expect(container.textContent).toContain("not enabled");
    expect(container.textContent).not.toContain("financial-analyst");
  });

  it("renders catalog contents and previews an update for an installed Claw", () => {
    const onPreviewUpdate = vi.fn();
    const container = document.createElement("div");
    render(
      renderClaws(
        props({
          mode: "discover",
          catalogDetail,
          installedCatalogAgent: status.records[0],
          onPreviewUpdate,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Financial Analyst");
    expect(container.textContent).toContain("Scheduled work");
    (container.querySelector(".claws-catalog-detail .btn.primary") as HTMLButtonElement).click();
    expect(onPreviewUpdate).toHaveBeenCalledWith(status.records[0], catalogDetail);
  });

  it("requires trust acknowledgement before confirming an unblocked plan", () => {
    const onApplyPlan = vi.fn();
    const container = document.createElement("div");
    render(renderClaws(props({ plan, onApplyPlan })), container);

    const confirm = container.querySelector(
      ".claws-plan__actions .btn.primary",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(container.textContent).toContain("Capabilities requiring consent");

    render(renderClaws(props({ plan, riskAcknowledged: true, onApplyPlan })), container);
    const enabledConfirm = container.querySelector(
      ".claws-plan__actions .btn.primary",
    ) as HTMLButtonElement;
    expect(enabledConfirm.disabled).toBe(false);
    enabledConfirm.click();
    expect(onApplyPlan).toHaveBeenCalledOnce();
  });

  it("never enables confirmation while the canonical plan has blockers", () => {
    const container = document.createElement("div");
    render(
      renderClaws(
        props({
          plan: {
            ...plan,
            blockers: [{ code: "workspace_conflict", path: "workspace", message: "Resolve it." }],
          },
          riskAcknowledged: true,
        }),
      ),
      container,
    );

    expect(
      (container.querySelector(".claws-plan__actions .btn.primary") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(container.textContent).toContain("workspace_conflict");
  });
});
