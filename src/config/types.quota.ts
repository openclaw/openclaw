export type QuotaConfig = {
  enabled?: boolean;
  storage?: {
    backend: "dynamodb" | "redis";
    dynamodb?: {
      tableName: string;
      region?: string;
      endpoint?: string;
    };
    redis?: {
      url?: string;
      keyPrefix?: string;
    };
  };
  plans?: Record<string, { tokenLimit: number; label?: string }>;
  defaultPlan?: string;
  customerHeader?: string;
  customerEnvVar?: string;
  quotaExceededMessage?: string;
};
