/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import type { ClawConfiguredAccess } from "../../../../packages/gateway-protocol/src/schema/claws.js";
import { i18n } from "../../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import {
  hasCompleteClawDisclosures,
  hasCompleteClawRemoveSchedules,
  renderClawAccessReview,
} from "./claws-access-review.ts";

const snapshot: NonNullable<ClawConfiguredAccess["desired"]> = {
  tools: { allowed: ["read"], excluded: ["exec"], explicitAllow: ["read"], explicitDeny: [] },
  sandbox: { mode: "non-main", scope: "agent", workspaceAccess: "ro", backend: "docker" },
  filesystem: { workspaceOnly: true },
  heartbeat: { enabled: false, intervalMs: null },
  memorySearch: { state: "disabled" },
  subagentTargets: {
    allowedAgentIds: ["workflow"],
    allowAnyConfiguredAgent: false,
    implicitSelfAllowed: true,
    requireAgentId: false,
  },
};

const current = {
  schedule: { cron: "0 8 * * *", timezone: "UTC" },
  session: "main" as const,
  delivery: "none" as const,
  messageDigest: "sha256:current-task",
};
const proposed = {
  schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
  session: "isolated" as const,
  delivery: "last-channel" as const,
  message: "Prepare the daily brief <without executing HTML>",
  messageDigest: "sha256:proposed-task",
};

beforeEach(async () => {
  registerAgentsHomeEnglish();
  await i18n.setLocale("en");
});

describe("Claw access review", () => {
  it("requires exact current schedule coverage before Remove", () => {
    const action = { kind: "cronJob", id: "daily-brief", action: "remove", blocked: false };
    expect(hasCompleteClawRemoveSchedules({ actions: [action] })).toBe(false);
    expect(
      hasCompleteClawRemoveSchedules({
        actions: [action],
        scheduledJobs: {
          coverage: "package-declarations",
          jobs: [{ id: "daily-brief", action: "remove", blocked: false, current }],
        },
      }),
    ).toBe(true);
  });
  it("discloses configured spawn targets and unresolved memory without claiming it is on", () => {
    const plan = {
      operation: "add" as const,
      actions: [],
      configuredAccess: {
        coverage: "configuration-only" as const,
        desired: {
          ...snapshot,
          memorySearch: { state: "unresolved" as const },
          subagentTargets: {
            allowedAgentIds: ["workflow", "research"],
            allowAnyConfiguredAgent: true,
            implicitSelfAllowed: true,
            requireAgentId: false,
          },
        },
        unresolved: ["memory-runtime" as const, "subagent-runtime" as const],
      },
      scheduledJobs: { coverage: "package-declarations" as const, jobs: [] },
    };
    expect(hasCompleteClawDisclosures(plan)).toBe(true);
    const container = document.createElement("div");
    render(renderClawAccessReview(plan), container);
    const facts = Object.fromEntries(
      [...container.querySelectorAll(".claws-access-review__fact")].map((fact) => [
        fact.querySelector("dt")?.textContent,
        fact.querySelector("dd")?.textContent,
      ]),
    );
    expect(facts["Memory search"]).toBe("Unresolved");
    expect(facts["Agent tool allowlist"]).toBe("read");
    expect(facts["Spawn targets"]).toBe("workflow, research");
    expect(facts["Any configured agent"]).toBe("Yes");
    expect(facts["Self when agent ID omitted"]).toBe("Yes");
    expect(facts["Agent ID required"]).toBe("No");
  });

  it("shows the exact package-authored Add task as escaped text", () => {
    const plan = {
      operation: "add" as const,
      actions: [{ kind: "cronJob", id: "daily-brief", action: "schedule", blocked: false }],
      configuredAccess: {
        coverage: "configuration-only" as const,
        desired: snapshot,
        unresolved: [],
      },
      scheduledJobs: {
        coverage: "package-declarations" as const,
        jobs: [{ id: "daily-brief", action: "schedule", blocked: false, proposed }],
      },
    };
    expect(hasCompleteClawDisclosures(plan)).toBe(true);
    const container = document.createElement("div");
    render(renderClawAccessReview(plan), container);
    expect(container.textContent).toContain("After Add: 0 9 * * * America/Los_Angeles");
    expect(container.textContent).toContain("Prepare the daily brief <without executing HTML>");
    expect(container.querySelector("without")).toBeNull();
  });

  it("shows before/after Update schedules and rejects a missing current declaration", () => {
    const plan = {
      operation: "update" as const,
      actions: [
        { kind: "cronJob", id: "daily-brief", action: "change", blocked: false },
        { kind: "cronJob", id: "weekly-review", action: "remove", blocked: false },
      ],
      configuredAccess: {
        coverage: "configuration-only" as const,
        current: snapshot,
        desired: snapshot,
        unresolved: [],
      },
      scheduledJobs: {
        coverage: "package-declarations" as const,
        jobs: [
          { id: "daily-brief", action: "change", blocked: false, current, proposed },
          { id: "weekly-review", action: "remove", blocked: false, current },
        ],
      },
    };
    expect(hasCompleteClawDisclosures(plan)).toBe(true);
    const container = document.createElement("div");
    render(renderClawAccessReview(plan), container);
    expect(container.textContent).toContain("Current: 0 8 * * * UTC");
    expect(container.textContent).toContain("After Update: 0 9 * * * America/Los_Angeles");
    expect(container.querySelectorAll(".claws-access-review__jobs li")).toHaveLength(2);
    expect(container.textContent).toContain("Prepare the daily brief <without executing HTML>");

    const missingCurrent = {
      ...plan,
      scheduledJobs: {
        ...plan.scheduledJobs,
        jobs: [
          { id: "daily-brief", action: "change", blocked: false, proposed },
          { id: "weekly-review", action: "remove", blocked: false, current },
        ],
      },
    };
    expect(hasCompleteClawDisclosures(missingCurrent)).toBe(false);
  });
});
