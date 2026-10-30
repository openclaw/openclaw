/* @vitest-environment jsdom */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CronJob, CronJobsListResult } from "../../api/types.ts";
import { buildAgentContext } from "../../lib/agents/display.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  agentsCapability,
  agentsList,
  agentsRouteData,
  createAgentsPage,
  gateway,
  pageContext,
  snapshot,
} from "./agents-page.test-support.ts";
import { AgentCron } from "./panel-cron.tsx";

function job(id: string, agentId = "main"): CronJob {
  return {
    id,
    name: `Job ${id}`,
    agentId,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Synthetic summary" },
    state: {},
  };
}
function pageOf(jobs: CronJob[], total = jobs.length, offset = 0): CronJobsListResult {
  const nextOffset = offset + jobs.length;
  return {
    jobs,
    total,
    offset,
    limit: 50,
    snapshotRevision: "cron-test",
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
}
function mount(request: GatewayRequestHandler) {
  const client = createTestGatewayClient(request);
  const currentGateway = gateway({
    ...snapshot(client),
    hello: gatewayHelloForMethods(["cron.list", "cron.status", "cron.run", "cron.runs"]),
  });
  const agents = agentsCapability(async () => ({ agentId: "main", workspace: "", files: [] }));
  agents.state.agentsList = { ...agentsList, agents: [{ id: "main" }, { id: "other" }] };
  const context = pageContext(currentGateway, agents);
  const page = createAgentsPage(context, {
    ...agentsRouteData(
      currentGateway,
      agents.state.agentsList,
      "main",
      context.settingsAgentSelection,
    ),
    panel: "cron",
  });
  const mounted = mountSolid(() => (
    <AgentCron
      {...page.read().cron}
      readState={() => page.read().readData().cron}
      basePath=""
      context={buildAgentContext({ id: "main" }, null, null, "main")}
      canRunNow={true}
      onSelectPanel={() => {}}
    />
  ));
  return { page, context, container: mounted.container };
}
function button(container: HTMLElement, label: string) {
  const result = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === label,
  );
  if (!result) {
    throw new Error(`Missing button: ${label}`);
  }
  return result;
}
function jobRow(container: HTMLElement, name: string) {
  const row = [...container.querySelectorAll(".settings-row")].find(
    (entry) => entry.querySelector(".settings-row__title")?.textContent === name,
  );
  if (!row) {
    throw new Error(`Missing row: ${name}`);
  }
  return row;
}

describe("Agent Cron native reads and actions", () => {
  it("shows ready jobs independently, retries failed reads without replacing job rows", async () => {
    const status = createDeferred();
    let first = true;
    let failJobs = false;
    const { page, container } = mount((method, params) => {
      if (method === "cron.status") {
        return first ? status.promise : { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      if (isRecord(params) && params.limit === 50 && failJobs) {
        throw new Error("Synthetic jobs unavailable");
      }
      return pageOf([job("ready")]);
    });
    await waitForSolid(() => expect(container.textContent).toContain("Job ready"));
    const row = jobRow(container, "Job ready");
    expect(button(container, "Refreshing…").disabled).toBe(true);
    status.reject(new Error("Synthetic status unavailable"));
    await waitForSolid(() =>
      expect(container.textContent).toContain("Synthetic status unavailable"),
    );
    first = false;
    button(container, "Refresh").click();
    await waitForSolid(() => {
      expect(container.textContent).not.toContain("Synthetic status unavailable");
      expect(button(container, "Refresh").disabled).toBe(false);
    });
    expect(jobRow(container, "Job ready")).toBe(row);
    expect(page.read().readData().cron.cronStatus?.enabled).toBe(true);
    failJobs = true;
    button(container, "Refresh").click();
    await waitForSolid(() => expect(container.textContent).toContain("Synthetic jobs unavailable"));
    expect(jobRow(container, "Job ready")).toBe(row);
    failJobs = false;
    button(container, "Refresh").click();
    await waitForSolid(() => {
      expect(container.textContent).not.toContain("Synthetic jobs unavailable");
      expect(button(container, "Refresh").disabled).toBe(false);
    });
    expect(jobRow(container, "Job ready")).toBe(row);
  });

  it("keeps refresh pending until a failed read's sibling finishes", async () => {
    const status = createDeferred();
    const jobs = createDeferred<CronJobsListResult>();
    const { container } = mount((method, params) => {
      if (method === "cron.status") {
        return status.promise;
      }
      if (isRecord(params) && params.limit === 50) {
        return jobs.promise;
      }
      return pageOf([]);
    });
    await waitForSolid(() => expect(button(container, "Refreshing…").disabled).toBe(true));
    status.reject(new Error("Synthetic status unavailable"));
    await waitForSolid(() => {
      expect(container.textContent).toContain("Synthetic status unavailable");
      expect(button(container, "Refreshing…").disabled).toBe(true);
    });
    jobs.resolve(pageOf([]));
    await waitForSolid(() => expect(button(container, "Refresh").disabled).toBe(false));
  });

  it("retains loaded rows during an admitted page append", async () => {
    const more = createDeferred<CronJobsListResult>();
    const { container } = mount((method, params) => {
      if (method === "cron.status") {
        return { enabled: true, jobs: 2, nextWakeAtMs: null };
      }
      if (isRecord(params) && params.offset === 1) {
        return more.promise;
      }
      return pageOf([job("first")], 2);
    });
    await waitForSolid(() => expect(container.querySelector(".cron-load-more")).not.toBeNull());
    const row = jobRow(container, "Job first");
    container.querySelector<HTMLButtonElement>(".cron-load-more")!.click();
    flush();
    expect(container.querySelector<HTMLButtonElement>(".cron-load-more")?.disabled).toBe(true);
    expect(jobRow(container, "Job first")).toBe(row);
    more.resolve(pageOf([job("second")], 2, 1));
    await waitForSolid(() => expect(container.textContent).toContain("Job second"));
    expect(jobRow(container, "Job first")).toBe(row);
  });

  it("reports a failed run, retries, and releases pending presentation when the selected agent changes", async () => {
    const firstRun = createDeferred();
    const secondRun = createDeferred();
    let runs = 0;
    const { page, context, container } = mount((method, params) => {
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      if (method === "cron.run") {
        return ++runs === 1 ? firstRun.promise : secondRun.promise;
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, limit: 50, hasMore: false };
      }
      const agentId =
        isRecord(params) && typeof params.agentId === "string" ? params.agentId : "main";
      return pageOf([job(agentId, agentId)]);
    });
    await waitForSolid(() => expect(container.textContent).toContain("Job main"));
    button(container, "Run Now").click();
    await waitForSolid(() => expect(button(container, "Run Now").disabled).toBe(true));
    firstRun.reject(new Error("Synthetic run unavailable"));
    await waitForSolid(() => expect(container.textContent).toContain("Synthetic run unavailable"));
    expect(button(container, "Run Now").disabled).toBe(false);
    button(container, "Run Now").click();
    await waitForSolid(() => expect(button(container, "Run Now").disabled).toBe(true));
    const previous = page.read().readData().cron;
    context.settingsAgentSelection.set("other");
    flush();
    await waitForSolid(() => expect(container.textContent).toContain("Job other"));
    expect(button(container, "Run Now").disabled).toBe(false);
    secondRun.reject(new Error("Retired run failure"));
    await waitForSolid(() => expect(previous.cronBusy).toBe(false));
    expect(container.textContent).not.toContain("Retired run failure");
    expect(runs).toBe(2);
  });
});
