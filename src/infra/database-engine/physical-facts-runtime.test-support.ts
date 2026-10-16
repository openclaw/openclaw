import type { PostgresPhysicalFacts } from "./physical-facts.js";

export const physicalFactsTestEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "physical-facts-worker.test-support",
  distWorkerPath: "infra/database-engine/physical-facts-worker.test-support.js",
} as const;

export type PhysicalFactsTestResult = {
  threadId: number;
  facts: PostgresPhysicalFacts;
  catalogReads: number[];
  nativeHasParents: boolean;
  writtenName: unknown;
  reusedAdmissionId: string;
  renewedAdmissionId: string;
  identityError: string;
  versionError: string;
  missingError: string;
};
