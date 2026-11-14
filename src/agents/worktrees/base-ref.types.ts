export type ResolvedWorktreeBase = {
  commit: string;
  gitOperand: string;
  recordRef: string;
  noOrigin?: true;
  fetchSucceeded?: boolean;
  warning?: string;
  preparationKey?: string;
};
