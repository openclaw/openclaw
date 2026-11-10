/* @vitest-environment jsdom */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CronJob, CronJobsListResult, CronStatus } from "../../api/types.ts";
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
  emitGatewaySnapshot,
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
    (entry) => entry.textContent?.trim() === label || entry.getAttribute("aria-label") === label,
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
  it("shows initial loading while status and inventory settle independently", async () => {
    const jobs = createDeferred<CronJobsListResult>();
    const status = createDeferred<CronStatus>();
    const { container } = mount((method) =>
      method === "cron.status" ? status.promise : jobs.promise,
    );
    await waitForSolid(() => expect(button(container, "Refresh").disabled).toBe(true));
    const sections = () => [...container.querySelectorAll(".settings-section")];
    const loading = (title: string) =>
      sections()
        .find((section) => section.querySelector("h2")?.textContent === title)
        ?.querySelector('.settings-group [aria-busy="true"]');
    expect(loading("Scheduler")).toBeTruthy();
    expect(loading("Agent automations")).toBeTruthy();
    status.resolve({ enabled: false, jobs: 0, nextWakeAtMs: null });
    await waitForSolid(() => expect(jobRow(container, "Enabled").textContent).toContain("No"));
    expect(loading("Scheduler")).toBeTruthy();
    expect(loading("Agent automations")).toBeTruthy();
    jobs.resolve(pageOf([]));
    await waitForSolid(() => expect(container.textContent).toContain("No automations yet."));
    expect(loading("Scheduler")).toBeNull();
    expect(loading("Agent automations")).toBeNull();
  });

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
    expect(jobRow(container, "Automations").textContent).toContain("1");
    expect(button(container, "Refresh").disabled).toBe(true);
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

  it("keeps unsettled inventory out of empty state and retries initial errors", async () => {
    const jobs = createDeferred<CronJobsListResult>();
    const status = createDeferred<CronStatus>();
    let result = jobs.promise;
    const { container, context } = mount((method) =>
      method === "cron.status" ? status.promise : result,
    );
    await waitForSolid(() => expect(button(container, "Refresh").disabled).toBe(true));
    expect(container.textContent).not.toContain("No automations yet.");
    expect(container.textContent).not.toContain("0 of");
    jobs.reject(new Error("Synthetic jobs unavailable"));
    await waitForSolid(() => expect(container.textContent).toContain("Synthetic jobs unavailable"));
    expect(button(container, "Refresh").disabled).toBe(true);
    await waitForSolid(() =>
      expect(jobRow(container, "Automations").textContent).toContain("Failed"),
    );
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    status.resolve({ enabled: false, triggersEnabled: true, jobs: 0, nextWakeAtMs: null });
    await waitForSolid(() => expect(button(container, "Refresh").disabled).toBe(false));
    expect(container.textContent).not.toContain("No automations yet.");
    expect(container.textContent).not.toContain("0 of");
    expect(jobRow(container, "Enabled").textContent).toContain("No");
    expect(jobRow(container, "Next wake").textContent).toContain("n/a");
    result = Promise.resolve(pageOf([]));
    button(container, "Refresh").click();
    await waitForSolid(() => expect(container.textContent).toContain("No automations yet."));
    const client = context.gateway.snapshot.client;
    emitGatewaySnapshot(context.gateway, snapshot(client, false));
    emitGatewaySnapshot(context.gateway, snapshot(client));
    expect(container.textContent).toContain("No automations yet.");
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
    button(container, "Run now").click();
    await waitForSolid(() => expect(button(container, "Run now").disabled).toBe(true));
    firstRun.reject(new Error("Synthetic run unavailable"));
    await waitForSolid(() => expect(container.textContent).toContain("Synthetic run unavailable"));
    expect(button(container, "Run now").disabled).toBe(false);
    button(container, "Run now").click();
    await waitForSolid(() => expect(button(container, "Run now").disabled).toBe(true));
    const previous = page.read().readData().cron;
    context.settingsAgentSelection.set("other");
    flush();
    await waitForSolid(() => expect(container.textContent).toContain("Job other"));
    expect(button(container, "Run now").disabled).toBe(false);
    secondRun.reject(new Error("Retired run failure"));
    await waitForSolid(() => expect(previous.cronBusy).toBe(false));
    expect(container.textContent).not.toContain("Retired run failure");
    expect(runs).toBe(2);
  });
});
