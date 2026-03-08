import crypto from "node:crypto";
import type { ProvenanceRef } from "./entity.js";

export type RepoOwnershipEntry = {
  repoId: string;
  githubRepo?: string;
  localPath: string;
  ownedGlobs: string[];
  sourceOfTruthDomains: string[];
  dependentRepos: string[];
  ciChecks: string[];
  validationCommands: string[];
  rollbackHints: string[];
};

export type RepoOwnershipRule = RepoOwnershipEntry;

export type RepoOwnershipMap = {
  version: "sre.repo-ownership-map.v1";
  generatedAt: string;
  repos: RepoOwnershipEntry[];
};

export type ChangePlanStep = {
  repoId: string;
  summary: string;
  ownedGlobs: string[];
  validationCommands: string[];
  rationale?: string;
  files?: string[];
  rollback?: string;
  pr?: {
    title?: string;
    base?: string;
    labels?: string[];
  };
  dependsOn?: string[];
};

export type ChangePlan = {
  version: "sre.change-plan.v1";
  planId: string;
  incidentId: string;
  requestId?: string;
  summary: string;
  rootCauseSummary?: string;
  status: "approved" | "completed" | "draft" | "executing" | "rejected";
  generatedAt: string;
  repos: string[];
  steps: ChangePlanStep[];
  interRepoDependencies?: Array<{ repoId: string; dependsOn: string[] }>;
  provenance: ProvenanceRef[];
};

function stableHash(parts: readonly string[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\u001f");
  }
  return hash.digest("hex").slice(0, 16);
}

export function createChangePlanId(
  params: Pick<ChangePlan, "incidentId" | "generatedAt"> & { repoIds: string[] },
): string {
  return `plan:${stableHash([params.incidentId, params.generatedAt, ...[...params.repoIds].toSorted()])}`;
}

export function createRepoOwnershipMap(
  params: Omit<RepoOwnershipMap, "repos" | "version"> & { repos: RepoOwnershipEntry[] },
): RepoOwnershipMap {
  return {
    version: "sre.repo-ownership-map.v1",
    ...params,
    repos: [...params.repos].toSorted((left, right) => left.repoId.localeCompare(right.repoId)),
  };
}
