import type { GatewayBrowserClient } from "../gateway.ts";
import type { JobsListResult, TrackedJob } from "../types.ts";

export type JobsHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  jobsLoading: boolean;
  jobsError: string | null;
  jobsList: JobsListResult | null;
  jobsSelectedRunId: string | null;
  jobsSelectedJob: TrackedJob | null;
  jobsFilterStatus: string;
  jobsFilterChannel: string;
  jobsHideHeartbeats: boolean;
};

export async function loadJobs(host: JobsHost) {
  if (!host.client || !host.connected) {
    return;
  }
  host.jobsLoading = true;
  host.jobsError = null;
  try {
    const params: Record<string, unknown> = {
      limit: 200,
      includeCompleted: true,
      hideHeartbeats: host.jobsHideHeartbeats,
    };
    if (host.jobsFilterStatus) {
      params.status = host.jobsFilterStatus;
    }
    if (host.jobsFilterChannel) {
      params.channel = host.jobsFilterChannel;
    }
    const res = await host.client.request<JobsListResult>("jobs.list", params);
    if (res) {
      host.jobsList = res;
    }
  } catch (err) {
    host.jobsError = String(err);
  } finally {
    host.jobsLoading = false;
  }
}

export async function loadJobDetail(host: JobsHost, runId: string) {
  if (!host.client || !host.connected) {
    return;
  }
  try {
    const res = await host.client.request<{ job: TrackedJob }>("jobs.get", { runId });
    if (res?.job) {
      host.jobsSelectedJob = res.job;
      host.jobsSelectedRunId = runId;
    }
  } catch (err) {
    host.jobsError = String(err);
  }
}

export function handleJobsEvent(host: JobsHost, payload: Record<string, unknown> | undefined) {
  if (!payload) {
    return;
  }
  const type = payload.type;
  if (type === "update" && payload.job) {
    const updated = payload.job as TrackedJob;
    if (!host.jobsList) {
      return;
    }
    const jobs = host.jobsList.jobs;
    const idx = jobs.findIndex((j) => j.runId === updated.runId);
    if (idx >= 0) {
      jobs[idx] = updated;
    } else {
      // Insert at top for new jobs
      jobs.unshift(updated);
    }
    // Recount active and total
    const activeCount = jobs.filter((j) => j.status === "running").length;
    host.jobsList = { ...host.jobsList, jobs: [...jobs], activeCount, total: jobs.length };
    // Update detail panel if watching this job
    if (host.jobsSelectedRunId === updated.runId) {
      host.jobsSelectedJob = updated;
    }
  }
}
