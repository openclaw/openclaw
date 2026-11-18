/* @vitest-environment jsdom */
import { flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { TemplateImportReview } from "./template-import-review.tsx";
import type { TemplateAddReviewPlan } from "./templates-catalog-client.ts";

function plan(): TemplateAddReviewPlan {
  return {
    schemaVersion: "openclaw.templatesGatewayPlan.v1",
    operation: "add",
    planIntegrity: "sealed-review",
    target: { agentId: "example" },
    reviewFiles: [],
    actions: [
      ...["SOUL.md", "AGENTS.md", "notes.md"].map((id) => ({
        kind: "workspaceFile",
        id,
        action: "write",
        blocked: false,
        effect: {
          type: "workspace-file" as const,
          destination: "workspace/" + id,
          desiredDigest: "digest",
        },
      })),
      {
        kind: "package",
        id: "skill:@example/weather",
        action: "install",
        blocked: false,
        effect: {
          type: "skill-package",
          desired: {
            source: "clawhub",
            ref: "@example/weather",
            version: "1.0.0",
            integrity: "sha256:" + "a".repeat(64),
          },
        },
      },
    ],
    capabilities: [],
    pluginReviews: [],
    skillReviews: [],
    blockers: [],
    riskAcknowledgementRequired: false,
    manifestDisclosure: {
      source: {
        packageName: "@example/briefing",
        version: "0.1.2",
        integrity: "sha256:" + "a".repeat(64),
        byteLength: 100,
      },
      manifestJson: JSON.stringify({
        agent: {
          name: "Example briefing",
          description: "A private briefing from selected sources.",
        },
      }),
    },
  };
}

describe("shared local Template review", () => {
  it("uses the chat card’s navigation, archive identity and Blobster without a publisher badge or behavior disclosure", () => {
    const value = plan();
    value.reviewFiles = [
      { path: "SOUL.md", content: "Reviewed instructions", workspacePaths: ["SOUL.md"] },
    ];
    const view = mountSolid(() => (
      <TemplateImportReview plan={value} readPackagePreview={() => Promise.resolve(null)} />
    ));
    expect(view.container.querySelector(".template-creator")).not.toBeNull();
    expect(view.getByRole("heading", { name: "Example briefing" })).toBeTruthy();
    expect(view.getByText("@example/briefing · v0.1.2")).toBeTruthy();
    expect(view.queryByText("Behavior and authority")).toBeNull();
    expect(view.container.querySelector(".template-creator__status")).toBeNull();
    expect(view.container.querySelector(".template-package-art svg")).not.toBeNull();
    view.getByRole("button", { name: /Workspace files/ }).click();
    flush();
    view.getByRole("button", { name: "SOUL.md" }).click();
    flush();
    expect(view.container.textContent).toContain("Reviewed instructions");
    view.getByRole("button", { name: "Back to contents" }).click();
    flush();
    view.getByRole("button", { name: "Back to Template" }).click();
    flush();
    view.getByRole("button", { name: /Skills/ }).click();
    flush();
    expect(view.getByRole("button", { name: "@example/weather" })).toBeTruthy();
    view.unmount();
  });

  it("uses canonical automation names and readable redacted MCP details", () => {
    const value = plan();
    const manifest = JSON.parse(value.manifestDisclosure!.manifestJson);
    value.manifestDisclosure!.manifestJson = JSON.stringify({
      ...manifest,
      automations: [{ id: "daily-check", name: "Morning briefing" }],
    });
    value.scheduledJobs = {
      coverage: "package-declarations",
      jobs: [
        {
          id: "daily-check",
          action: "create",
          blocked: false,
          proposed: {
            enabled: true,
            schedule: { cron: "0 9 * * *", timezone: "UTC" },
            session: "isolated",
            delivery: "none",
            messageDigest: "digest",
            message: "Prepare briefing",
          },
        },
      ],
    };
    value.actions.push({
      kind: "mcpServer",
      id: "incident-tools",
      action: "create",
      blocked: false,
      effect: {
        type: "mcp-server",
        proposed: {
          transport: "stdio",
          command: "npx",
          arguments: ["--isolated"],
          environment: [{ name: "TOKEN", sourceName: "EXAMPLE_TOKEN" }],
          authentication: "none",
        },
      },
    });
    const view = mountSolid(() => (
      <TemplateImportReview plan={value} readPackagePreview={() => Promise.resolve(null)} />
    ));
    view.getByRole("button", { name: /MCP servers/ }).click();
    flush();
    view.getByRole("button", { name: "incident-tools" }).click();
    flush();
    expect(view.getByText("Arguments")).toBeTruthy();
    expect(view.getByText("--isolated")).toBeTruthy();
    expect(view.container.textContent).toContain("${EXAMPLE_TOKEN}");
    expect(view.container.textContent).not.toContain("templatesDraft.serverFields.");
    view.getByRole("button", { name: "Back to contents" }).click();
    flush();
    view.getByRole("button", { name: "Back to Template" }).click();
    flush();
    view.getByRole("button", { name: /Automations/ }).click();
    flush();
    view.getByRole("button", { name: "Morning briefing" }).click();
    flush();
    expect(view.getByText("Prepare briefing")).toBeTruthy();
    view.unmount();
  });
});
