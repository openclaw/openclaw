/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import type { TemplateAddReviewPlan } from "./templates-catalog-client.ts";
import { ReviewWarning } from "./templates-detail-view.tsx";

const plan: TemplateAddReviewPlan = {
  schemaVersion: "openclaw.templatesGatewayPlan.v1",
  operation: "add",
  planIntegrity: "review-integrity",
  target: { agentId: "example" },
  actions: [
    {
      kind: "workspace",
      id: "SOUL.md",
      action: "write",
      blocked: false,
      effect: { type: "workspace-file", destination: "SOUL.md", desiredDigest: "file-digest" },
    },
  ],
  capabilities: [],
  pluginReviews: [],
  skillReviews: [],
  blockers: [],
  riskAcknowledgementRequired: false,
  configuredAccess: { coverage: "configuration-only", unresolved: ["runtime-tools"] },
  scheduledJobs: {
    coverage: "package-declarations",
    jobs: [
      {
        id: "daily",
        action: "create",
        blocked: false,
        proposed: {
          schedule: { cron: "0 9 * * *", timezone: "UTC" },
          session: "isolated",
          delivery: "owner",
          messageDigest: "digest",
          message: "Daily task",
        },
      },
    ],
  },
  manifestDisclosure: {
    source: {
      packageName: "example",
      version: "1.0.0",
      integrity: `sha256:${"a".repeat(64)}`,
      byteLength: 123,
    },
    manifestJson: '{"agent":"example"}',
    openClawProfileJson: '{"tools":{"allow":["read"]}}',
  },
};

describe("Template review", () => {
  it("retains review while applying and restores Cancel only when settled", () => {
    const cancel = vi.fn();
    const [applying, setApplying] = createSignal(false);
    const view = mountSolid(() => (
      <ReviewWarning
        view={{
          reviewPlan: plan,
          applying: applying(),
          onCancelReview: cancel,
          onConfirmReview: vi.fn(),
        }}
      />
    ));
    const button = view.container.querySelector<HTMLButtonElement>(
      ".templates-add-consent__actions button",
    )!;
    setApplying(true);
    flush();
    expect(button.disabled).toBe(true);
    button.click();
    expect(cancel).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("Daily task");
    setApplying(false);
    flush();
    button.click();
    expect(cancel).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("discloses server plan facts and action effects before confirmation", () => {
    const view = mountSolid(() => (
      <ReviewWarning
        view={{
          reviewPlan: plan,
          applying: false,
          onCancelReview: vi.fn(),
          onConfirmReview: vi.fn(),
        }}
      />
    ));
    for (const text of [
      "Configured access",
      "configuration-only",
      "runtime-tools",
      "Scheduled jobs",
      "Daily task",
      "0 9 * * *",
      "Manifest disclosure",
      plan.manifestDisclosure!.manifestJson,
      plan.manifestDisclosure!.openClawProfileJson!,
      "file-digest",
    ]) {
      expect(view.container.textContent).toContain(text);
    }
    const facts = view.container.querySelector(".templates-plan-disclosures")!;
    const confirm = view.getByRole("button", { name: "Add anyway" });
    expect(facts.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(Array.from(facts.querySelectorAll("details")).every((item) => item.open)).toBe(true);
    view.unmount();
  });
});
