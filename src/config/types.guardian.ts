export type GuardianRuleMode = "public" | "needs_key" | "deny";

export type GuardianRule = {
  mode: GuardianRuleMode;
  path: string;
};

export type GuardianConfig = {
  enabled?: boolean;
  keyFileName?: string;
  rules?: GuardianRule[];
  cacheTtlMs?: number;
  failMode?: "closed" | "open";
};
