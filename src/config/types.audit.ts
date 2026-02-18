export type AuditModelTrafficRedactConfig = {
  enabled?: boolean;
  keys?: string[];
  maskChar?: string;
  headVisible?: number;
  tailVisible?: number;
};

export type AuditModelTrafficGranularityConfig = {
  headers?: boolean;
  body?: boolean;
  response?: boolean;
};

export type AuditModelTrafficConfig = {
  enabled?: boolean;
  path?: string;
  redact?: AuditModelTrafficRedactConfig;
  granularity?: AuditModelTrafficGranularityConfig;
};

export type AuditConfig = {
  modelTraffic?: AuditModelTrafficConfig;
};
