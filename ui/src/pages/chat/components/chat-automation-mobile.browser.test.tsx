import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { CronJob, CronRunLogEntry } from "../../../api/types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  SessionAutomationMobileBody,
  type SessionAutomationMobileHistoryProps,
} from "./chat-automation-mobile.tsx";

it("forwards mobile history search, status ordering and the selected run to native callbacks", async () => {
  const run: CronRunLogEntry = {
    jobId: "release",
    runId: "run-release",
    ts: 1000,
    action: "finished",
    status: "error",
    summary: "Release needs review",
  };
  const job: CronJob = {
    id: "release",
    name: "Release digest",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 600_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Review release" },
    state: {},
  };
  const onViewRunTranscript = vi.fn();
  const onRunsFiltersChange =
    vi.fn<
      (patch: Parameters<SessionAutomationMobileHistoryProps["onRunsFiltersChange"]>[0]) => void
    >();
  const [history, setHistory] = createSignal<SessionAutomationMobileHistoryProps>({
    runs: [run],
    runsState: "ready",
    runsHasMore: false,
    runsLoadingMore: false,
    runsStatuses: [],
    runsDeliveryStatuses: [],
    runsQuery: "",
    runsSortDir: "desc",
    runsSortBy: "time",
    onLoadMoreRuns: vi.fn(),
    onRefresh: vi.fn(),
    onViewRunTranscript,
    onRunsFiltersChange: (patch) => {
      onRunsFiltersChange(patch);
      setHistory((previous) => ({
        ...previous,
        runsQuery: patch.cronRunsQuery ?? previous.runsQuery,
        runsSortBy: patch.cronRunsSortBy ?? previous.runsSortBy,
        runsSortDir: patch.cronRunsSortDir ?? previous.runsSortDir,
      }));
    },
  });
  const view = mountSolid(() => (
    <SessionAutomationMobileBody
      job={job}
      tab="history"
      onTabChange={vi.fn()}
      history={history()}
      canManage={false}
      connected
      heartbeatScratch=""
      basePath=""
      onOpenEditor={vi.fn()}
    />
  ));
  await page.getByRole("searchbox").fill("release");
  expect(onRunsFiltersChange).toHaveBeenLastCalledWith({ cronRunsQuery: "release" });
  await page.getByRole("combobox", { name: "Order", exact: true }).selectOptions("status");
  expect(onRunsFiltersChange).toHaveBeenLastCalledWith({
    cronRunsSortBy: "status",
    cronRunsSortDir: "desc",
    cronRunsStatuses: [],
    cronRunsDeliveryStatuses: [],
  });
  await expect.element(page.getByRole("searchbox")).toHaveValue("release");
  await page.getByRole("combobox", { name: "Order", exact: true }).selectOptions("asc");
  expect(onRunsFiltersChange).toHaveBeenLastCalledWith({
    cronRunsSortBy: "time",
    cronRunsSortDir: "asc",
    cronRunsStatuses: [],
    cronRunsDeliveryStatuses: [],
  });
  const disclosure = view.container.querySelector("summary")!;
  await page.elementLocator(disclosure).click();
  const trigger = page.getByRole("button", { name: "View transcript", exact: true });
  await trigger.click();
  expect(onViewRunTranscript).toHaveBeenCalledWith(run, expect.any(HTMLButtonElement));
});
