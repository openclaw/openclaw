export type GatewayIncidentSource = "approval" | "device" | "node" | "runtime" | "security";

export type GatewayIncidentSeverity = "info" | "warn" | "critical";
export type GatewayIncidentStatus = "open" | "acked" | "resolved";
export type GatewayIncidentStatusFilter = GatewayIncidentStatus | "active" | "all";

export type GatewayIncidentMetadata = {
  logQuery?: string | null;
  sessionKey?: string | null;
  agentId?: string | null;
  channelId?: string | null;
  nodeId?: string | null;
  actionTab?: string | null;
  actionLabel?: string | null;
};

export type GatewayIncidentCandidate = {
  id: string;
  source: GatewayIncidentSource;
  severity: GatewayIncidentSeverity;
  title: string;
  detail: string;
  metadata?: GatewayIncidentMetadata | null;
};

export type GatewayIncidentRecord = {
  id: string;
  source: GatewayIncidentSource;
  severity: GatewayIncidentSeverity;
  status: GatewayIncidentStatus;
  title: string;
  detail: string;
  metadata: GatewayIncidentMetadata;
  firstDetectedAt: number;
  lastSeenAt: number;
  updatedAt: number;
  acknowledgedAt?: number;
  acknowledgedBy?: string | null;
  resolvedAt?: number;
  resolvedBy?: string | null;
  occurrenceCount: number;
};

export type GatewayIncidentSummary = {
  active: number;
  open: number;
  acked: number;
  resolved: number;
  critical: number;
  warn: number;
  info: number;
};

const MAX_INCIDENTS = 256;
const RESOLVED_RETENTION_MS = 24 * 60 * 60 * 1000;

function normalizeText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function normalizeMetadata(metadata?: GatewayIncidentMetadata | null): GatewayIncidentMetadata {
  return {
    logQuery: normalizeText(metadata?.logQuery) || null,
    sessionKey: normalizeText(metadata?.sessionKey) || null,
    agentId: normalizeText(metadata?.agentId) || null,
    channelId: normalizeText(metadata?.channelId) || null,
    nodeId: normalizeText(metadata?.nodeId) || null,
    actionTab: normalizeText(metadata?.actionTab) || null,
    actionLabel: normalizeText(metadata?.actionLabel) || null,
  };
}

function metadataEqual(left: GatewayIncidentMetadata, right: GatewayIncidentMetadata): boolean {
  return (
    left.logQuery === right.logQuery &&
    left.sessionKey === right.sessionKey &&
    left.agentId === right.agentId &&
    left.channelId === right.channelId &&
    left.nodeId === right.nodeId &&
    left.actionTab === right.actionTab &&
    left.actionLabel === right.actionLabel
  );
}

function severityRank(severity: GatewayIncidentSeverity): number {
  if (severity === "critical") {
    return 0;
  }
  if (severity === "warn") {
    return 1;
  }
  return 2;
}

function statusRank(status: GatewayIncidentStatus): number {
  if (status === "open") {
    return 0;
  }
  if (status === "acked") {
    return 1;
  }
  return 2;
}

export class IncidentManager {
  private records = new Map<string, GatewayIncidentRecord>();

  sync(candidates: GatewayIncidentCandidate[], now = Date.now()) {
    let changed = false;
    const seen = new Set<string>();

    for (const candidate of candidates) {
      const id = normalizeText(candidate.id);
      if (!id) {
        continue;
      }
      seen.add(id);
      const metadata = normalizeMetadata(candidate.metadata);
      const title = normalizeText(candidate.title) || id;
      const detail = normalizeText(candidate.detail) || "No detail provided.";
      const current = this.records.get(id);
      if (!current) {
        this.records.set(id, {
          id,
          source: candidate.source,
          severity: candidate.severity,
          status: "open",
          title,
          detail,
          metadata,
          firstDetectedAt: now,
          lastSeenAt: now,
          updatedAt: now,
          occurrenceCount: 1,
        });
        changed = true;
        continue;
      }

      const contentChanged =
        current.source !== candidate.source ||
        current.severity !== candidate.severity ||
        current.title !== title ||
        current.detail !== detail ||
        !metadataEqual(current.metadata, metadata);

      current.source = candidate.source;
      current.severity = candidate.severity;
      current.title = title;
      current.detail = detail;
      current.metadata = metadata;
      current.lastSeenAt = now;

      if (current.status === "resolved") {
        current.status = "open";
        current.acknowledgedAt = undefined;
        current.acknowledgedBy = null;
        current.resolvedAt = undefined;
        current.resolvedBy = null;
        current.occurrenceCount += 1;
        current.updatedAt = now;
        changed = true;
        continue;
      }

      if (contentChanged) {
        current.updatedAt = now;
        changed = true;
      }
    }

    for (const record of this.records.values()) {
      if (seen.has(record.id) || record.status === "resolved") {
        continue;
      }
      record.status = "resolved";
      record.resolvedAt = now;
      record.resolvedBy = "system:auto-clear";
      record.updatedAt = now;
      changed = true;
    }

    if (this.prune(now)) {
      changed = true;
    }

    return changed;
  }

  ack(id: string, actor?: string | null): GatewayIncidentRecord | null {
    const record = this.records.get(normalizeText(id));
    if (!record) {
      return null;
    }
    if (record.status !== "open") {
      return record;
    }
    record.status = "acked";
    record.acknowledgedAt = Date.now();
    record.acknowledgedBy = normalizeText(actor) || null;
    record.updatedAt = Date.now();
    return record;
  }

  resolve(id: string, actor?: string | null): GatewayIncidentRecord | null {
    const record = this.records.get(normalizeText(id));
    if (!record) {
      return null;
    }
    if (record.status === "resolved") {
      return record;
    }
    record.status = "resolved";
    record.resolvedAt = Date.now();
    record.resolvedBy = normalizeText(actor) || null;
    record.updatedAt = Date.now();
    return record;
  }

  list(opts?: { status?: GatewayIncidentStatusFilter; limit?: number }) {
    const status = opts?.status ?? "active";
    const limit = typeof opts?.limit === "number" && opts.limit > 0 ? opts.limit : 50;
    return [...this.records.values()]
      .filter((record) => {
        if (status === "all") {
          return true;
        }
        if (status === "active") {
          return record.status === "open" || record.status === "acked";
        }
        return record.status === status;
      })
      .toSorted((left, right) => {
        const statusDelta = statusRank(left.status) - statusRank(right.status);
        if (statusDelta !== 0) {
          return statusDelta;
        }
        const severityDelta = severityRank(left.severity) - severityRank(right.severity);
        if (severityDelta !== 0) {
          return severityDelta;
        }
        return right.updatedAt - left.updatedAt;
      })
      .slice(0, limit)
      .map((record) => ({ ...record, metadata: { ...record.metadata } }));
  }

  summarize(): GatewayIncidentSummary {
    const summary: GatewayIncidentSummary = {
      active: 0,
      open: 0,
      acked: 0,
      resolved: 0,
      critical: 0,
      warn: 0,
      info: 0,
    };
    for (const record of this.records.values()) {
      if (record.status === "resolved") {
        summary.resolved += 1;
        continue;
      }
      summary.active += 1;
      if (record.status === "open") {
        summary.open += 1;
      } else if (record.status === "acked") {
        summary.acked += 1;
      }
      if (record.severity === "critical") {
        summary.critical += 1;
      } else if (record.severity === "warn") {
        summary.warn += 1;
      } else {
        summary.info += 1;
      }
    }
    return summary;
  }

  private prune(now: number) {
    let changed = false;
    for (const [id, record] of this.records.entries()) {
      if (record.status !== "resolved") {
        continue;
      }
      if ((record.resolvedAt ?? record.updatedAt) + RESOLVED_RETENTION_MS < now) {
        this.records.delete(id);
        changed = true;
      }
    }

    if (this.records.size <= MAX_INCIDENTS) {
      return changed;
    }

    const overflow = [...this.records.values()]
      .toSorted((left, right) => left.updatedAt - right.updatedAt)
      .slice(0, this.records.size - MAX_INCIDENTS);
    for (const record of overflow) {
      this.records.delete(record.id);
      changed = true;
    }
    return changed;
  }
}
