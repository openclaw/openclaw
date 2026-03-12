import { compileOperatorAgentRegistry } from "./agent-registry.js";

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/u, "");
}

export function resolve2TonyBaseUrl(): string | null {
  return normalizeBaseUrl(
    process.env.OPENCLAW_OPERATOR_2TONY_URL ??
      process.env.BT_2TONY_BASE_URL ??
      process.env.TWO_TONY_BASE_URL,
  );
}

export function resolve2TonySharedSecret(): string | null {
  const secret =
    process.env.OPENCLAW_OPERATOR_2TONY_SHARED_SECRET?.trim() ||
    process.env.BT_2TONY_SHARED_SECRET?.trim() ||
    process.env.TWO_TONY_SHARED_SECRET?.trim();
  return secret || null;
}

function resolveDelegatedTransportBaseUrl(): string | null {
  return normalizeBaseUrl(process.env.OPENCLAW_OPERATOR_ANGELA_URL);
}

function resolveDelegatedTransportSharedSecret(): string | null {
  const secret =
    process.env.OPENCLAW_OPERATOR_ANGELA_SHARED_SECRET?.trim() ||
    process.env.OPENCLAW_ANGELA_SHARED_SECRET?.trim();
  return secret || null;
}

export function resolveOperatorReceiptBaseUrl(): string | null {
  return normalizeBaseUrl(
    process.env.OPENCLAW_OPERATOR_RECEIPT_BASE_URL ??
      process.env.OPENCLAW_PUBLIC_BASE_URL ??
      process.env.GATEWAY_BASE_URL,
  );
}

export function resolveOperatorReceiptTemplate(): string | null {
  const explicit = process.env.OPENCLAW_OPERATOR_RECEIPT_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const base = resolveOperatorReceiptBaseUrl();
  if (!base) {
    return null;
  }
  return `${base}/mission-control/api/tasks/{taskId}/receipts`;
}

export type OperatorWorkerStatusSnapshot = {
  dispatchTransport: "2tony-http";
  configured: boolean;
  baseUrl: string | null;
  receiptTemplate: string | null;
  authScheme: "bearer" | null;
  authEnv: string | null;
  authConfigured: boolean;
};

export type OperatorDelegatedTransportStatusSnapshot = {
  dispatchTransport: "angela-http";
  configured: boolean;
  baseUrl: string | null;
  authScheme: "bearer" | null;
  authEnv: string | null;
  authConfigured: boolean;
  globalDefaultAlias: string | null;
  servedTeams: string[];
  leadAliases: string[];
  defaultAliasByTeam: Record<string, string>;
};

function resolveDelegatedTransportDomains(): Pick<
  OperatorDelegatedTransportStatusSnapshot,
  "globalDefaultAlias" | "servedTeams" | "leadAliases" | "defaultAliasByTeam"
> {
  const registry = compileOperatorAgentRegistry();
  const teams = registry.teams
    .filter((team) => team.dispatchTransport === "angela-http")
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const leadAliases = Array.from(
    new Set(teams.map((team) => team.lead?.trim()).filter((lead): lead is string => Boolean(lead))),
  ).toSorted((left, right) => left.localeCompare(right));
  return {
    globalDefaultAlias: registry.operatorRuntime.transports.angelaHttp.globalDefaultAlias,
    servedTeams: teams.map((team) => team.id),
    leadAliases,
    defaultAliasByTeam: Object.fromEntries(
      teams
        .filter(
          (team) => typeof team.dispatchDefaultAlias === "string" && team.dispatchDefaultAlias,
        )
        .map((team) => [team.id, team.dispatchDefaultAlias as string]),
    ),
  };
}

export function getOperatorWorkerStatus(): OperatorWorkerStatusSnapshot {
  const baseUrl = resolve2TonyBaseUrl();
  const sharedSecret = resolve2TonySharedSecret();
  return {
    dispatchTransport: "2tony-http",
    configured: Boolean(baseUrl),
    baseUrl,
    receiptTemplate: resolveOperatorReceiptTemplate(),
    authScheme: "bearer",
    authEnv: "OPENCLAW_OPERATOR_2TONY_SHARED_SECRET",
    authConfigured: Boolean(sharedSecret),
  };
}

export function getOperatorDelegatedTransportStatus(): OperatorDelegatedTransportStatusSnapshot {
  const baseUrl = resolveDelegatedTransportBaseUrl();
  const sharedSecret = resolveDelegatedTransportSharedSecret();
  const domains = resolveDelegatedTransportDomains();
  return {
    dispatchTransport: "angela-http",
    configured: Boolean(baseUrl),
    baseUrl,
    authScheme: "bearer",
    authEnv: "OPENCLAW_OPERATOR_ANGELA_SHARED_SECRET",
    authConfigured: Boolean(sharedSecret),
    globalDefaultAlias: domains.globalDefaultAlias,
    servedTeams: domains.servedTeams,
    leadAliases: domains.leadAliases,
    defaultAliasByTeam: domains.defaultAliasByTeam,
  };
}
