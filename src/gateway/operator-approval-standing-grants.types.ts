/** Cron identity plus exact operation binding recorded at approval creation. */
export type CronStandingGrantMintSpec = {
  agentId: string;
  cronJobId: string;
  jobConfigRevision: string;
  operationBinding: string;
};
