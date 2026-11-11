import type { SessionsCatalogListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import type { ChatModelPickerTargetGroup } from "../chat/components/chat-model-picker-options.ts";
import { isNewSessionCatalogTarget as isTarget, type NewSessionRouteData } from "./location.ts";
import { newSessionModelLocationFromSearch } from "./model-location.ts";

registerNewSessionSetupEnglish();

function draftRouteKey(
  requestedAgentId: string,
  catalogId: string,
  group: string,
  model?: string,
): string {
  return JSON.stringify([requestedAgentId, catalogId, group, ...(model ? [model] : [])]);
}

/**
 * Which draft a new-session route has open. This keys on the requested agent,
 * not the resolved one: a catalog route resolves its agent through the Gateway
 * and reports it empty until the roster arrives, so keying on the resolved id
 * would make that fill-in look like a navigation and discard the draft.
 */
export function routeKey(data?: NewSessionRouteData): string {
  return draftRouteKey(
    data?.requestedAgentId ?? "",
    data?.catalogId ?? "",
    data?.group ?? "",
    data?.requestedModel,
  );
}

export function routeKeyFromSearch(search: string): string {
  const location = newSessionModelLocationFromSearch(search);
  return draftRouteKey(
    location.agentId,
    location.catalogId,
    location.group ?? "",
    location.requestedModel,
  );
}

export function requestedModelForAgent(
  data: NewSessionRouteData | undefined,
  agentId: string,
): string | undefined {
  return !data?.requestedAgentId ||
    normalizeAgentId(data.requestedAgentId) === normalizeAgentId(agentId)
    ? data?.requestedModel
    : undefined;
}

export { isTarget };

function isResolvedTarget(data?: NewSessionRouteData): boolean {
  return Boolean(data?.catalogId && data.startTerminal && data.catalogLabel);
}

export function isPendingRouteTarget(data?: NewSessionRouteData): boolean {
  return (
    (isTarget(data) && !isResolvedTarget(data)) ||
    Boolean(data?.group && data.groupStatus !== "resolved")
  );
}

export function groupDefaultsKey(data?: NewSessionRouteData): string {
  return JSON.stringify([
    data?.groupStatus ?? "",
    data?.groupCwd ?? "",
    data?.groupWorktree === true,
  ]);
}

export function isGroupRoutePending(
  data: NewSessionRouteData | undefined,
  sessions: SessionCapability | undefined,
): boolean {
  return Boolean(data?.group && (!sessions || data.groupStatus !== "resolved"));
}

export function isRoutePending(
  data: NewSessionRouteData | undefined,
  sessions: SessionCapability | undefined,
): boolean {
  return isPendingRouteTarget(data) || isGroupRoutePending(data, sessions);
}

export function resolvedGroupName(
  data: NewSessionRouteData | undefined,
  sessions: SessionCapability | undefined,
): string | undefined {
  return data?.groupStatus === "resolved" && !isGroupRoutePending(data, sessions)
    ? data.group
    : undefined;
}

export function resolveAgentId(
  data: Pick<NewSessionRouteData, "agentId"> | undefined,
  availableAgents: readonly { id: string }[],
  fallback: string,
): string {
  const rawRequested = data?.agentId?.trim();
  const requested = rawRequested ? normalizeAgentId(rawRequested) : undefined;
  return requested &&
    availableAgents.some((candidate) => normalizeAgentId(candidate.id) === requested)
    ? requested
    : fallback && normalizeAgentId(fallback);
}

export function allowsSelectedAgent(
  data: NewSessionRouteData | undefined,
  selectedAgent: unknown,
): boolean {
  return !isTarget(data) || (isResolvedTarget(data) && Boolean(selectedAgent));
}

export async function resolveCreateTarget(
  snapshot: ApplicationGatewaySnapshot,
  catalogId: string,
  agentId?: string,
): Promise<
  Pick<NewSessionRouteData, "catalogLabel" | "startTerminal" | "terminalHosts"> | undefined
> {
  if (
    !snapshot.client ||
    !canCallGatewayMethod(snapshot, "sessions.catalog.list", "operator.read")
  ) {
    return undefined;
  }
  try {
    const result = await snapshot.client.request<SessionsCatalogListResult>(
      "sessions.catalog.list",
      {
        ...(agentId ? { agentId } : {}),
        catalogId,
        limitPerHost: 1,
      },
    );
    const catalog = result.catalogs.find((candidate) => candidate.id === catalogId);
    const terminal = catalog?.capabilities.startTerminal;
    return catalog && terminal === true
      ? {
          catalogLabel: catalog.label,
          startTerminal: true,
          terminalHosts: catalog.hosts
            .filter((host) => host.canStartTerminal === true)
            .map(({ hostId, label }) => ({ hostId, label })),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

type CatalogTargetOwner = { agentId: string; client: GatewayBrowserClient };
type CatalogTargetRead = {
  owner: CatalogTargetOwner;
  completion: ChatModelPickerTargetGroup["completion"];
  options?: ChatModelPickerTargetGroup["options"];
  canRetry: boolean;
};

export class CatalogTargetDiscovery {
  private read: CatalogTargetRead | undefined;

  constructor(private readonly notify: () => void) {}

  clear() {
    const previous = this.read;
    this.read = undefined;
    if (previous) {
      this.notify();
    }
  }

  private startRequest(owner: CatalogTargetOwner) {
    const read: CatalogTargetRead = {
      owner,
      canRetry: false,
      completion: {
        promise: owner.client
          .request<SessionsCatalogListResult>("sessions.catalog.list", {
            agentId: owner.agentId,
            metadataOnly: true,
          })
          .then(
            (result) => {
              const options = result.catalogs
                .filter((catalog) => catalog.capabilities.startTerminal === true)
                .map(({ id, label }) => ({ value: id, label }));
              if (this.read === read) {
                read.options = options;
                this.notify();
              }
              return options;
            },
            (error: unknown) => {
              if (this.read === read) {
                // Retry admission stays synchronous at the discovery owner.
                read.canRetry = true;
                this.notify();
              }
              throw error;
            },
          ),
      },
    };
    // A scope can retire before its renderer observes the rejected receipt.
    void read.completion.promise.catch(() => {});
    this.read = read;
    this.notify();
  }

  load(
    context: Pick<ApplicationContext, "gateway"> | undefined,
    agentId: string,
    enabled: boolean,
  ) {
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.client;
    const normalizedAgentId = agentId.trim() ? normalizeAgentId(agentId) : "";
    if (
      !enabled ||
      !client ||
      !normalizedAgentId ||
      !canCallGatewayMethod(snapshot, "sessions.catalog.list", "operator.read")
    ) {
      this.clear();
      return;
    }
    const owner = { agentId: normalizedAgentId, client };
    const current = this.read;
    if (
      current &&
      current.owner.client === owner.client &&
      current.owner.agentId === owner.agentId
    ) {
      return;
    }

    this.clear();
    this.startRequest(owner);
  }

  retry(snapshot: ApplicationGatewaySnapshot | undefined, agentId: string) {
    const targetDiscovery = this.read;
    if (
      targetDiscovery?.canRetry &&
      canCallGatewayMethod(snapshot, "sessions.catalog.list", "operator.read") &&
      targetDiscovery.owner.client === snapshot?.client &&
      targetDiscovery.owner.agentId === agentId
    ) {
      this.startRequest(targetDiscovery.owner);
    }
  }

  groups(): readonly ChatModelPickerTargetGroup[] | undefined {
    const discovery = this.read;
    if (!discovery || discovery.options?.length === 0) {
      return undefined;
    }
    return [
      {
        errorLabel: t("newSession.cliAgentsUnavailable"),
        id: "cliAgents",
        label: t("newSession.cliAgentsGroup"),
        options: discovery.options ?? [],
        completion: discovery.completion,
      },
    ];
  }
}
