export type QuotaStatus = {
  customerId: string;
  plan: string;
  tokenLimit: number;
  tokensUsed: number;
  tokensRemaining: number;
  exceeded: boolean;
};

export interface QuotaStore {
  getUsage(customerId: string): Promise<{ tokensUsed: number; plan: string } | null>;
  incrementUsage(customerId: string, tokens: number): Promise<void>;
  setCustomer(customerId: string, plan: string): Promise<void>;
  close(): Promise<void>;
}
