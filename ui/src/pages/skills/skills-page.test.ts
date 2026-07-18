/* @vitest-environment jsdom */

// Skills page hydration tests cover verdict loading for route-provided
// reports and the empty-verdict backfill (#108647).
import { describe, expect, it, vi } from "vitest";
import type { SkillStatusReport } from "../../api/types.ts";
import "./skills-page.ts";
import type { SkillsRouteData } from "./skills-page.ts";

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

type SkillsPageHandle = HTMLElement & {
  routeData?: SkillsRouteData;
  connected: boolean;
  client: unknown;
  skillsReport: SkillStatusReport | null;
  clawhubVerdicts: Record<string, unknown>;
  clawhubVerdictsLoading: boolean;
};

const linkedReport = {
  workspaceDir: "/tmp/workspace",
  managedSkillsDir: "/tmp/skills",
  skills: [
    {
      name: "AgentReceipt",
      skillKey: "agentreceipt",
      source: "clawhub",
      clawhub: {
        status: "linked",
        valid: true,
        registry: "https://clawhub.ai",
        slug: "agentreceipt",
        installedVersion: "1.2.3",
        installedAt: 123,
      },
    },
  ],
} as unknown as SkillStatusReport;

const verdictResponse = {
  schema: "openclaw.skills.security-verdicts.v1",
  items: [
    {
      registry: "https://clawhub.ai",
      ok: true,
      decision: "pass",
      reasons: [],
      requestedSlug: "agentreceipt",
      requestedVersion: "1.2.3",
      slug: "agentreceipt",
      version: "1.2.3",
      securityStatus: "clean",
      securityPassed: true,
    },
  ],
};

function createPage() {
  const request = vi.fn<TestRequest>(async (method: string) =>
    method === "skills.securityVerdicts" ? verdictResponse : {},
  );
  const client = { request };
  const snapshot = { connected: true, client };
  const gateway = { snapshot, subscribe: () => () => undefined };
  const agents = {
    state: { agentsLoading: false, agentsError: null, agentsList: null },
    subscribe: () => () => undefined,
    ensureList: async () => null,
  };
  const page = document.createElement("openclaw-skills-page") as SkillsPageHandle;
  (page as unknown as { context: unknown }).context = { gateway, agents };
  return { page, request, gateway, snapshot, agents };
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("skills page verdict hydration", () => {
  it("hydrates verdicts when route data provides the skills report", async () => {
    const { page, request, gateway, snapshot, agents } = createPage();
    page.routeData = {
      gateway,
      gatewaySnapshot: snapshot,
      agents,
      agentsList: null,
      selectedAgentId: null,
      report: linkedReport,
      error: null,
    } as unknown as SkillsRouteData;

    (page as unknown as { applyRouteData: () => void }).applyRouteData();
    await flushAsync();

    expect(request).toHaveBeenCalledWith("skills.securityVerdicts", {});
    expect(Object.keys(page.clawhubVerdicts)).toHaveLength(1);
  });

  it("backfills missing verdicts on ensureInitialData when a report is already loaded", async () => {
    const { page, request } = createPage();
    page.connected = true;
    (page as unknown as { client: unknown }).client = (
      page as unknown as { context: { gateway: { snapshot: { client: unknown } } } }
    ).context.gateway.snapshot.client;
    // A report hydrated while disconnected leaves the verdict map empty with
    // no retry; the next gateway event must backfill it.
    page.skillsReport = linkedReport;
    page.clawhubVerdicts = {};

    (page as unknown as { ensureInitialData: () => void }).ensureInitialData();
    await flushAsync();

    expect(request).toHaveBeenCalledWith("skills.securityVerdicts", {});
    expect(Object.keys(page.clawhubVerdicts)).toHaveLength(1);
  });
});
