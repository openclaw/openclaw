import type { ClawLifecyclePlanResult } from "../../../../packages/gateway-protocol/src/schema/claws.js";
import type {
  ClawHubClawCatalogDetail,
  ClawHubClawCatalogEntry,
} from "../../../../src/claws/clawhub-source.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ClawPluginAcknowledgement } from "./claws-plugin-review.ts";
import type { ClawSkillAcknowledgement } from "./claws-skill-review.ts";

export type ClawCatalogEntry = ClawHubClawCatalogEntry;
export type ClawCatalogDetail = ClawHubClawCatalogDetail;
export type ClawCatalogSource = { packageName: string; version: string };

export type ClawAddPlan = ClawLifecyclePlanResult & { operation: "add" };

export type ClawAddApplyResult = {
  agentId: string;
  status: string;
  readiness: { ready: boolean; requirements?: Array<{ kind: string; owner: string }> };
  error?: { code: string; message: string };
};

type ClawResourceStatus = {
  kind: string;
  id: string;
  state: string;
  reason?: string;
  relationship?: "managed" | "referenced";
  origin?: "claw-introduced" | "pre-existing";
  independentOwner?: boolean;
};

export type ClawStatusRecord = {
  agentId: string;
  name: string;
  version: string;
  sourceKind: "package" | "development";
  status: string;
  agentState: string;
  bootstrapState: string;
  orphaned: boolean;
  addedAtMs: number;
  updatedAtMs: number;
  resources: ClawResourceStatus[];
};

export async function listClawStatus(client: GatewayBrowserClient): Promise<ClawStatusRecord[]> {
  const result = await client.request<{ records: ClawStatusRecord[] }>("claws.status", {});
  return result.records;
}

export async function readClawStatus(
  client: GatewayBrowserClient,
  agentId: string,
): Promise<ClawStatusRecord | null> {
  const result = await client.request<{ records: ClawStatusRecord[] }>("claws.status", {
    target: agentId,
  });
  return result.records.find((record) => record.agentId === agentId) ?? null;
}

function isOfficialEntry(entry: ClawCatalogEntry): boolean {
  return (
    entry.official && entry.channel === "official" && entry.packageName.startsWith("@openclaw/")
  );
}

export async function searchOfficialClaws(
  client: GatewayBrowserClient,
  query: string,
  limit?: number,
): Promise<ClawCatalogEntry[]> {
  const trimmed = query.trim();
  const result = await client.request<{ entries: ClawCatalogEntry[] }>("claws.catalog.search", {
    ...(trimmed ? { query: trimmed } : {}),
    ...(limit ? { limit } : {}),
  });
  return result.entries.filter(isOfficialEntry);
}

export async function readLatestOfficialClawDetail(
  client: GatewayBrowserClient,
  packageName: string,
): Promise<ClawCatalogDetail> {
  if (!/^@openclaw\/[a-z0-9][a-z0-9._-]*$/.test(packageName)) {
    throw new Error("Only official Claws can be updated from ClawHub.");
  }
  const entries = await searchOfficialClaws(client, packageName, 100);
  const latestVersion = entries.find((entry) => entry.packageName === packageName)?.latestVersion;
  if (!latestVersion) {
    throw new Error("No published release is available for this Claw.");
  }
  return await readOfficialClawDetail(client, { packageName, version: latestVersion });
}

export async function readOfficialClawDetail(
  client: GatewayBrowserClient,
  source: ClawCatalogSource,
): Promise<ClawCatalogDetail> {
  const result = await client.request<{ detail: ClawCatalogDetail }>(
    "claws.catalog.detail",
    source,
  );
  const detail = result.detail;
  if (
    !isOfficialEntry(detail) ||
    detail.packageName !== source.packageName ||
    detail.version !== source.version
  ) {
    throw new Error("ClawHub returned a different Claw release.");
  }
  return detail;
}

export async function planOfficialClawAdd(
  client: GatewayBrowserClient,
  source: ClawCatalogSource,
): Promise<ClawAddPlan> {
  return await client.request<ClawAddPlan>("claws.add.plan", { source });
}

export async function applyOfficialClawAdd(
  client: GatewayBrowserClient,
  source: ClawCatalogSource,
  plan: ClawAddPlan,
  acknowledgeClawHubRisk: boolean,
  acknowledgeCapabilities: ClawPluginAcknowledgement[],
  acknowledgeSkillWarnings: ClawSkillAcknowledgement[],
): Promise<ClawAddApplyResult> {
  return await client.request<ClawAddApplyResult>("claws.add.apply", {
    source,
    planIntegrity: plan.planIntegrity,
    ...(plan.riskAcknowledgementRequired ? { acknowledgeClawHubRisk } : {}),
    ...(acknowledgeCapabilities.length ? { acknowledgeCapabilities } : {}),
    ...(acknowledgeSkillWarnings.length ? { acknowledgeSkillWarnings } : {}),
  });
}
