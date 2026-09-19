export type LogsTailPayload = {
  file?: string;
  source?: string;
  sourceKind?: "file" | "journal";
  service?: {
    pid?: number;
    unit?: string;
  };
  cursor?: number | string;
  size?: number;
  lines?: string[];
  truncated?: boolean;
  reset?: boolean;
  skippedBytes?: number;
  localFallback?: boolean;
};

type LogSourceIdentity = {
  file?: string;
  source?: string;
  sourceKind?: LogsTailPayload["sourceKind"];
  servicePid?: number;
  serviceUnit?: string;
  localFallback?: boolean;
};

export function normalizeLogTailPayloadSource(payload: LogsTailPayload): LogsTailPayload {
  if (payload.sourceKind || !payload.file) {
    return payload;
  }
  return { ...payload, sourceKind: "file" };
}

export function buildLogSourceIdentity(payload: LogsTailPayload): string | undefined {
  const sourceKind = payload.sourceKind ?? (payload.file ? "file" : undefined);
  if (!sourceKind && !payload.file && !payload.source) {
    return undefined;
  }
  const identity: LogSourceIdentity = {
    file: payload.file,
    source: payload.source,
    sourceKind,
    servicePid: payload.service?.pid,
    serviceUnit: payload.service?.unit,
    localFallback: payload.localFallback === true ? true : undefined,
  };
  return JSON.stringify(identity);
}

export function buildLogMetaRecord(payload: LogsTailPayload): Record<string, unknown> {
  return {
    type: "meta",
    file: payload.file,
    source: payload.source,
    sourceKind: payload.sourceKind ?? (payload.file ? "file" : undefined),
    service: payload.service,
    cursor: payload.cursor,
    size: payload.size,
    localFallback: payload.localFallback === true ? true : undefined,
  };
}
