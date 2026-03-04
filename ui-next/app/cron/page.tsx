"use client";

import { useState, useCallback, useEffect } from "react";
import { formatRelativeTimestamp, formatMs } from "@/lib/format";
import type {
  CronJob,
  CronStatus,
  CronJobsListResult,
  CronRunsResult,
  CronRunLogEntry,
  CronJobCreate,
} from "@/lib/types";
import { useGateway } from "@/lib/use-gateway";
import { CreateJobModal } from "./create-job-modal";

// ============================================
// Helpers
// ============================================

function formatScheduleText(job: CronJob): string {
  const schedule = job.schedule;
  if (!schedule) {
    return "No schedule";
  }
  if (schedule.kind === "at") {
    return `Once at ${schedule.at}`;
  }
  if (schedule.kind === "every") {
    const ms = schedule.everyMs ?? 0;
    const mins = Math.round(ms / 60000);
    return `Every ${mins} minute${mins !== 1 ? "s" : ""}`;
  }
  if (schedule.kind === "cron") {
    return schedule.expr ?? "Cron expression";
  }
  return "Unknown schedule";
}

function formatNextRun(nextMs: number | null | undefined): string {
  if (!nextMs) {
    return "Not scheduled";
  }
  const now = Date.now();
  if (nextMs <= now) {
    return "Running now";
  }
  return formatRelativeTimestamp(nextMs);
}

// ============================================
// Styles
// ============================================

const styles = {
  summaryStrip: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    background: "var(--card)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: 16,
    marginBottom: 20,
  } as React.CSSProperties,
  summaryLeft: {
    display: "flex",
    gap: 24,
  } as React.CSSProperties,
  summaryItem: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  } as React.CSSProperties,
  summaryLabel: {
    fontSize: 12,
    color: "var(--muted)",
    fontWeight: 500,
  } as React.CSSProperties,
  summaryValue: {
    fontSize: 14,
    color: "var(--text-strong)",
    fontWeight: 600,
  } as React.CSSProperties,
  card: {
    background: "var(--card)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: 20,
    marginBottom: 20,
  } as React.CSSProperties,
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
  } as React.CSSProperties,
  cardTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: "var(--text-strong)",
    margin: 0,
  } as React.CSSProperties,
  cardSub: {
    fontSize: 13,
    color: "var(--muted)",
    marginTop: 4,
  } as React.CSSProperties,
  btn: {
    height: 28,
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 500,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--secondary)",
    color: "var(--text)",
    cursor: "pointer",
  } as React.CSSProperties,
  btnPrimary: {
    background: "var(--accent)",
    color: "#fff",
    borderColor: "var(--accent)",
  } as React.CSSProperties,
  muted: {
    color: "var(--muted)",
    fontSize: 13,
  } as React.CSSProperties,
  callout: {
    padding: "10px 14px",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    marginTop: 12,
  } as React.CSSProperties,
  calloutDanger: {
    background: "var(--danger-subtle)",
    color: "var(--danger)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--danger)",
  } as React.CSSProperties,
  filters: {
    display: "flex",
    alignItems: "flex-end",
    gap: 12,
    marginTop: 16,
    flexWrap: "wrap" as const,
  } as React.CSSProperties,
  field: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  } as React.CSSProperties,
  label: {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--muted)",
  } as React.CSSProperties,
  input: {
    height: 32,
    padding: "0 10px",
    fontSize: 13,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--bg)",
    color: "var(--text)",
    outline: "none",
    minWidth: 180,
  } as React.CSSProperties,
  select: {
    height: 32,
    padding: "0 10px",
    fontSize: 13,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--bg)",
    color: "var(--text)",
    outline: "none",
  } as React.CSSProperties,
  jobList: {
    marginTop: 16,
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  } as React.CSSProperties,
  jobItem: {
    background: "var(--bg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    padding: 16,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
  } as React.CSSProperties,
  jobMain: {
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  jobTitle: {
    fontSize: 14,
    fontWeight: 500,
    color: "var(--text-strong)",
    marginBottom: 4,
  } as React.CSSProperties,
  jobSub: {
    fontSize: 13,
    color: "var(--muted)",
    marginBottom: 8,
  } as React.CSSProperties,
  jobMeta: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 8,
  } as React.CSSProperties,
  chip: {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 500,
    borderRadius: 9999,
    background: "var(--bg-hover)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    color: "var(--muted)",
  } as React.CSSProperties,
  chipOk: {
    background: "var(--ok-subtle)",
    borderColor: "var(--ok)",
    color: "var(--ok)",
  } as React.CSSProperties,
  chipWarn: {
    background: "var(--warn-subtle)",
    borderColor: "var(--warn)",
    color: "var(--warn)",
  } as React.CSSProperties,
  jobActions: {
    display: "flex",
    gap: 8,
    flexShrink: 0,
  } as React.CSSProperties,
  runsList: {
    marginTop: 16,
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  } as React.CSSProperties,
  runItem: {
    background: "var(--bg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    padding: 12,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  } as React.CSSProperties,
  runMain: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  } as React.CSSProperties,
};

// ============================================
// JobCard Component
// ============================================

function JobCard({
  job,
  busy,
  onToggle,
  onRun,
  onRemove,
  onViewRuns,
}: {
  job: CronJob;
  busy: boolean;
  onToggle: () => void;
  onRun: () => void;
  onRemove: () => void;
  onViewRuns: () => void;
}) {
  const nextRun = job.state?.nextRunAtMs;
  const lastStatus = job.state?.lastStatus;

  return (
    <div style={styles.jobItem}>
      <div style={styles.jobMain}>
        <div style={styles.jobTitle}>{job.name}</div>
        <div style={styles.jobSub}>{job.description || formatScheduleText(job)}</div>
        <div style={styles.jobMeta}>
          <span
            style={{
              ...styles.chip,
              ...(job.enabled ? styles.chipOk : styles.chipWarn),
            }}
          >
            {job.enabled ? "Enabled" : "Disabled"}
          </span>
          {lastStatus && (
            <span
              style={{
                ...styles.chip,
                ...(lastStatus === "ok"
                  ? styles.chipOk
                  : lastStatus === "error"
                    ? styles.chipWarn
                    : {}),
              }}
            >
              Last: {lastStatus}
            </span>
          )}
          <span style={styles.chip}>Next: {formatNextRun(nextRun)}</span>
          {job.agentId && <span style={styles.chip}>Agent: {job.agentId}</span>}
        </div>
      </div>
      <div style={styles.jobActions}>
        <button style={styles.btn} disabled={busy} onClick={onViewRuns}>
          Runs
        </button>
        <button style={styles.btn} disabled={busy} onClick={onToggle}>
          {job.enabled ? "Disable" : "Enable"}
        </button>
        <button style={styles.btn} disabled={busy} onClick={onRun}>
          Run Now
        </button>
        <button style={styles.btn} disabled={busy} onClick={onRemove}>
          Delete
        </button>
      </div>
    </div>
  );
}

// ============================================
// RunLogItem Component
// ============================================

function RunLogItem({ entry }: { entry: CronRunLogEntry }) {
  return (
    <div style={styles.runItem}>
      <div style={styles.runMain}>
        <span
          style={{
            ...styles.chip,
            ...(entry.status === "ok"
              ? styles.chipOk
              : entry.status === "error"
                ? styles.chipWarn
                : {}),
          }}
        >
          {entry.status ?? "unknown"}
        </span>
        <span style={styles.muted}>{entry.jobName || entry.jobId}</span>
        {entry.durationMs != null && <span style={styles.muted}>{formatMs(entry.durationMs)}</span>}
      </div>
      <span style={styles.muted}>{entry.ts ? formatRelativeTimestamp(entry.ts) : "—"}</span>
    </div>
  );
}

// ============================================
// Main Cron Page
// ============================================

export default function CronPage() {
  const { state, request } = useGateway();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<CronStatus | null>(null);
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [jobsTotal, setJobsTotal] = useState(0);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [runsJobId, setRunsJobId] = useState<string | null>(null);
  const [runs, setRuns] = useState<CronRunLogEntry[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const loadStatus = useCallback(async () => {
    if (state !== "connected") {
      return;
    }

    try {
      const res = await request<CronStatus>("cron.status", {});
      setStatus(res);
    } catch {
      // Ignore status errors
    }
  }, [state, request]);

  const loadJobs = useCallback(async () => {
    if (state !== "connected") {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await request<CronJobsListResult>("cron.list", {
        includeDisabled: true,
      });
      setJobs(res.jobs ?? []);
      setJobsTotal(res.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load jobs");
    } finally {
      setLoading(false);
    }
  }, [state, request, filter]);

  const loadRuns = useCallback(
    async (jobId: string) => {
      if (state !== "connected") {
        return;
      }

      setRunsLoading(true);
      setRunsJobId(jobId);

      try {
        const res = await request<CronRunsResult>("cron.runs", {
          jobId,
          limit: 20,
        });
        setRuns(res.entries ?? []);
      } catch {
        setRuns([]);
      } finally {
        setRunsLoading(false);
      }
    },
    [state, request],
  );

  const handleToggle = useCallback(
    async (job: CronJob) => {
      setBusy(true);
      try {
        await request("cron.update", {
          jobId: job.id,
          patch: { enabled: !job.enabled },
        });
        await loadJobs();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to toggle job");
      } finally {
        setBusy(false);
      }
    },
    [request, loadJobs],
  );

  const handleRun = useCallback(
    async (job: CronJob) => {
      setBusy(true);
      try {
        await request("cron.run", { jobId: job.id });
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to run job");
      } finally {
        setBusy(false);
      }
    },
    [request],
  );

  const handleRemove = useCallback(
    async (job: CronJob) => {
      if (!confirm(`Delete job "${job.name}"?`)) {
        return;
      }

      setBusy(true);
      try {
        await request("cron.remove", { jobId: job.id });
        await loadJobs();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete job");
      } finally {
        setBusy(false);
      }
    },
    [request, loadJobs],
  );

  useEffect(() => {
    if (state === "connected") {
      void loadStatus();
      void loadJobs();
    }
  }, [state, loadStatus, loadJobs]);

  const handleCreateJob = useCallback(
    async (job: CronJobCreate) => {
      await request("cron.add", job);
      await loadJobs();
    },
    [request, loadJobs],
  );

  const filteredJobs = jobs.filter((job) => {
    if (!filter) {
      return true;
    }
    const q = filter.toLowerCase();
    return (
      job.name.toLowerCase().includes(q) ||
      job.description?.toLowerCase().includes(q) ||
      job.agentId?.toLowerCase().includes(q)
    );
  });

  const isDisabled = loading || state !== "connected";

  return (
    <div style={{ animation: "rise 0.3s ease-out" }}>
      <div style={{ marginBottom: 24 }}>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.025em",
            color: "var(--text-strong)",
            margin: 0,
          }}
        >
          Cron
        </h1>
        <p style={{ color: "var(--muted)", marginTop: 6, marginBottom: 0 }}>
          Manage scheduled tasks and automation jobs.
        </p>
      </div>

      {/* Status Strip */}
      <div style={styles.summaryStrip}>
        <div style={styles.summaryLeft}>
          <div style={styles.summaryItem}>
            <span style={styles.summaryLabel}>Scheduler</span>
            <span
              style={{
                ...styles.summaryValue,
                color: status?.enabled ? "var(--ok)" : "var(--muted)",
              }}
            >
              {status ? (status.enabled ? "Enabled" : "Disabled") : "..."}
            </span>
          </div>
          <div style={styles.summaryItem}>
            <span style={styles.summaryLabel}>Jobs</span>
            <span style={styles.summaryValue}>{status?.jobs ?? "—"}</span>
          </div>
          <div style={styles.summaryItem}>
            <span style={styles.summaryLabel}>Next Wake</span>
            <span style={styles.summaryValue}>{formatNextRun(status?.nextWakeAtMs)}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={styles.btn} disabled={isDisabled} onClick={loadJobs}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
          <button
            style={{ ...styles.btn, ...styles.btnPrimary }}
            disabled={isDisabled}
            onClick={() => setShowCreate(true)}
          >
            Add Job
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            ...styles.callout,
            ...styles.calloutDanger,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {/* Jobs Card */}
      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <div>
            <div style={styles.cardTitle}>Jobs</div>
            <div style={styles.cardSub}>
              {filteredJobs.length} of {jobsTotal} jobs
            </div>
          </div>
        </div>

        <div style={styles.filters}>
          <div style={styles.field}>
            <span style={styles.label}>Search</span>
            <input
              style={styles.input}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Name, description, or agent"
            />
          </div>
        </div>

        <div style={styles.jobList}>
          {filteredJobs.length === 0 ? (
            <div style={styles.muted}>{loading ? "Loading jobs..." : "No jobs found."}</div>
          ) : (
            filteredJobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                busy={busy}
                onToggle={() => handleToggle(job)}
                onRun={() => handleRun(job)}
                onRemove={() => handleRemove(job)}
                onViewRuns={() => loadRuns(job.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Runs Panel */}
      {runsJobId && (
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <div>
              <div style={styles.cardTitle}>Run History</div>
              <div style={styles.cardSub}>
                {jobs.find((j) => j.id === runsJobId)?.name ?? runsJobId}
              </div>
            </div>
            <button style={styles.btn} onClick={() => setRunsJobId(null)}>
              Close
            </button>
          </div>

          <div style={styles.runsList}>
            {runsLoading ? (
              <div style={styles.muted}>Loading runs...</div>
            ) : runs.length === 0 ? (
              <div style={styles.muted}>No run history.</div>
            ) : (
              runs.map((entry, idx) => <RunLogItem key={idx} entry={entry} />)
            )}
          </div>
        </div>
      )}

      {showCreate && (
        <CreateJobModal onClose={() => setShowCreate(false)} onSubmit={handleCreateJob} />
      )}
    </div>
  );
}
