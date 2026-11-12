/* @vitest-environment jsdom */
import { flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { templateImportFacts } from "./template-import-facts.ts";
import { TemplateImportReview } from "./template-import-review.tsx";
import type { TemplateAddReviewPlan } from "./templates-catalog-client.ts";

function plan(): TemplateAddReviewPlan {
  return {
    schemaVersion: "openclaw.templatesGatewayPlan.v1",
    operation: "add",
    planIntegrity: "sealed-review",
    target: { agentId: "example" },
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

describe("native local Template review", () => {
  it("shows compact plan-derived rows with real files and versioned packages, then structured details", () => {
    const view = mountSolid(() => <TemplateImportReview plan={plan()} />);
    expect(view.getByText("3 workspace files")).toBeTruthy();
    expect(
      view.container
        .querySelector(".template-import-capabilities")
        ?.classList.contains("template-import-surface"),
    ).toBe(true);
    const identity = view.container.querySelector(".template-import-identity")!;
    // The card's identity: artwork tile, name, then package and version.
    expect(identity.querySelector(".agents-home__template-art")).not.toBeNull();
    expect(identity.textContent).toContain("@example/briefing · v0.1.2");
    const description = view.container.querySelector(".template-import-identity__description")!;
    expect(description.textContent).toBe("A private briefing from selected sources.");
    expect(view.getByText("SOUL.md, AGENTS.md + 1 more")).toBeTruthy();
    expect(view.getByText("@example/weather · v1.0.0 · install")).toBeTruthy();
    const disclosures = [
      ...view.container.querySelectorAll<HTMLDetailsElement>(".template-import-capability"),
    ];
    expect(disclosures.every((row) => !row.open)).toBe(true);
    expect(new Set(disclosures.map((row) => row.name)).size).toBe(1);
    view.getByRole("tab", { name: "Details" }).click();
    flush();
    expect(view.getByRole("tabpanel").textContent).toContain("Package@example/briefing");
    expect(view.getByRole("tabpanel").textContent).toContain("Version0.1.2");
    // Switching tabs must not move the tabs: the header above them stays as it was.
    expect(description.isConnected).toBe(true);
    expect(
      view.container
        .querySelector(".template-import-detail-content")
        ?.classList.contains("template-import-surface"),
    ).toBe(true);
    expect(view.getByRole("tab", { name: "Details", exact: true })).toBeTruthy();
    view.unmount();
  });

  it("uses canonical automation names and discloses MCP installation commands", () => {
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
            schedule: { cron: "0 9 * * *", timezone: "UTC" },
            session: "isolated",
            delivery: "none",
            message: "Prepare briefing",
            messageDigest: "digest",
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
          arguments: ["@example/incident-mcp"],
          environment: [{ name: "API_KEY", sourceName: "INCIDENT_API_KEY" }],
          authentication: "none",
        },
      },
    });
    const view = mountSolid(() => <TemplateImportReview plan={value} />);
    expect(view.getByText("Morning briefing", { selector: ".settings-row__title" })).toBeTruthy();
    expect(view.getByText("MCP servers: 1")).toBeTruthy();
    const row = [...view.container.querySelectorAll(".template-import-capability")].find((item) =>
      item.textContent?.includes("incident-tools"),
    )!;
    for (const fact of [
      "create",
      "stdio",
      "npx",
      "@example/incident-mcp",
      "API_KEY",
      "INCIDENT_API_KEY",
    ]) {
      expect(row.textContent).toContain(fact);
    }
    view.unmount();
  });

  it("omits a missing bio without placeholder copy and retains fallback version in Details", () => {
    const value = plan();
    value.manifestDisclosure = undefined;
    value.target.targetVersion = "2.0.0";
    const view = mountSolid(() => <TemplateImportReview plan={value} />);
    expect(view.container.querySelector(".template-import-identity__description")).toBeNull();
    view.getByRole("tab", { name: "Details" }).click();
    flush();
    expect(view.getByRole("tabpanel").textContent).toContain("2.0.0");
    view.unmount();
  });

  it("distinguishes requested shell access from workspace file restrictions and effective policy", () => {
    const travel = plan();
    travel.manifestDisclosure!.openClawProfileJson = JSON.stringify({
      agent: {
        tools: { profile: "minimal", alsoAllow: ["read", "exec"], fs: { workspaceOnly: true } },
      },
    });
    const view = mountSolid(() => <TemplateImportReview plan={travel} />);
    expect(view.getByText("Command execution requested")).toBeTruthy();
    expect(view.getByText("Shell commands · Gateway policy applies")).toBeTruthy();
    expect(
      view.getByText("Workspace-only file access does not restrict shell commands."),
    ).toBeTruthy();
    expect(view.container.textContent).not.toContain("Sandbox off");
    expect(templateImportFacts(travel).requestsExec).toBe(true);
    expect(templateImportFacts(plan()).requestsExec).toBe(false);
    view.unmount();
  });
});
