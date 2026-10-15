import type { SessionsCatalogListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import type { ChatModelPickerTargetGroup } from "../chat/components/chat-model-picker-options.ts";
import type { NewSessionRouteData } from "./location.ts";
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

export function isTarget(data?: NewSessionRouteData): boolean {
  return Boolean(data?.catalogId);
}

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
  client: GatewayBrowserClient,
  catalogId: string,
  agentId?: string,
): Promise<
  Pick<NewSessionRouteData, "catalogLabel" | "startTerminal" | "terminalHosts"> | undefined
> {
  try {
    const result = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
      ...(agentId ? { agentId } : {}),
      catalogId,
      limitPerHost: 1,
    });
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
type CatalogTargetDiscoveryState =
  | { status: "idle" }
  | {
      status: "loading";
      owner: CatalogTargetOwner;
    }
  | { status: "ready"; owner: CatalogTargetOwner; targets: ChatModelPickerTargetGroup["options"] }
  | { status: "error"; owner: CatalogTargetOwner };

export class CatalogTargetDiscovery {
  private state: CatalogTargetDiscoveryState = { status: "idle" };

  constructor(private readonly notify: () => void) {}

  clear() {
    const previous = this.state;
    this.state = { status: "idle" };
    if (previous.status !== "idle") {
      this.notify();
    }
  }

  private startRequest(owner: CatalogTargetOwner) {
    this.state = { status: "loading", owner };
    this.notify();
    void owner.client
      .request<SessionsCatalogListResult>("sessions.catalog.list", {
        agentId: owner.agentId,
        metadataOnly: true,
      })
      .then(
        (result) => {
          if (
            this.state.status === "idle" ||
            this.state.owner.client !== owner.client ||
            this.state.owner.agentId !== owner.agentId
          ) {
            return;
          }
          this.state = {
            status: "ready",
            owner,
            targets: result.catalogs
              .filter((catalog) => catalog.capabilities.startTerminal === true)
              .map(({ id, label }) => ({ value: id, label })),
          };
          this.notify();
        },
        () => {
          if (this.state.status !== "idle" && this.state.owner === owner) {
            this.state = { status: "error", owner };
            this.notify();
          }
        },
      );
  }

  load(context: ApplicationContext | undefined, agentId: string, enabled: boolean) {
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.client;
    const normalizedAgentId = agentId.trim() ? normalizeAgentId(agentId) : "";
    if (
      !enabled ||
      snapshot?.phase !== "connected" ||
      !client ||
      !normalizedAgentId ||
      isGatewayMethodAdvertised(snapshot, "sessions.catalog.list") !== true
    ) {
      this.clear();
      return;
    }
    const owner = { agentId: normalizedAgentId, client };
    const current = this.state;
    if (
      current.status !== "idle" &&
      current.owner.client === owner.client &&
      current.owner.agentId === owner.agentId
    ) {
      return;
    }

    this.clear();
    this.startRequest(owner);
  }

  retry(client: GatewayBrowserClient | undefined, agentId: string) {
    const targetDiscovery = this.state;
    if (
      targetDiscovery.status === "error" &&
      targetDiscovery.owner.client === client &&
      targetDiscovery.owner.agentId === agentId
    ) {
      this.startRequest(targetDiscovery.owner);
    }
  }

  groups(): readonly ChatModelPickerTargetGroup[] | undefined {
    const discovery = this.state;
    if (
      discovery.status === "idle" ||
      (discovery.status === "ready" && !discovery.targets.length)
    ) {
      return undefined;
    }
    return [
      {
        errorLabel: t("newSession.cliAgentsUnavailable"),
        id: "cliAgents",
        label: t("newSession.cliAgentsGroup"),
        options: discovery.status === "ready" ? discovery.targets : [],
        status: discovery.status,
      },
    ];
  }
}
