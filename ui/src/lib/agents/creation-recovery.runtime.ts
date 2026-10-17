import { isGatewayProtocolResponseError } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult, ConfigSnapshot } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerAgentCreationEnglish } from "../../i18n/locales/en-agent-creation.ts";
import { buildAgentMainSessionKey } from "../sessions/session-key.ts";
import type {
  AgentCreationAttempt,
  AgentCreationResult,
  createAgentCreationRecovery,
} from "./creation-recovery.ts";
import type { AgentsState } from "./index.ts";

registerAgentCreationEnglish();

export class AgentCreationUncertainError extends Error {
  constructor() {
    super(t("agentChip.creationUncertain"));
    this.name = "AgentCreationUncertainError";
  }
}

/** A missing row only proves failure after the original request has settled on the server. */
async function reconcileAgentCreation(
  client: GatewayBrowserClient,
  attempt: AgentCreationAttempt,
): Promise<AgentCreationResult | null> {
  let snapshot: ConfigSnapshot;
  try {
    snapshot = await client.request<ConfigSnapshot>("config.get", {});
  } catch {
    throw new AgentCreationUncertainError();
  }
  const config = snapshot?.sourceConfig;
  if (!snapshot?.valid || !snapshot.exists || snapshot.writeError || !isRecord(config)) {
    throw new AgentCreationUncertainError();
  }
  const entries = isRecord(config.agents) ? config.agents.entries : undefined;
  const entry = isRecord(entries) ? entries[attempt.agentId] : undefined;
  if (!isRecord(entry)) {
    if (attempt.responseReceived) {
      return null;
    }
    throw new AgentCreationUncertainError();
  }
  const mainKey = isRecord(config.session) ? config.session.mainKey : undefined;
  return {
    agentId: attempt.agentId,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name : attempt.name,
    onboarding: {
      sessionKey: buildAgentMainSessionKey({
        agentId: attempt.agentId,
        mainKey: typeof mainKey === "string" ? mainKey : undefined,
      }),
      status: "error",
      error: t("agentChip.creationRecovered"),
    },
  };
}

/** Loaded after provisional navigation; the eager owner retains attempted identities. */
export async function executeAgentCreation(
  client: GatewayBrowserClient,
  attempt: AgentCreationAttempt,
  previous: boolean,
  attempts: Map<string, AgentCreationAttempt>,
  isCurrent: () => boolean,
): Promise<AgentCreationResult | null> {
  if (!isCurrent()) {
    return null;
  }
  const target = client.gatewayUrl;
  let created = attempt.receipt;
  if (!previous) {
    attempts.set(target, attempt);
    try {
      created = await client.request<AgentCreationResult>("agents.create", {
        agentId: attempt.agentId,
        name: attempt.name,
        onboarding: true,
      });
      attempt.receipt = created;
    } catch (error) {
      attempt.rejection = error;
      attempt.responseReceived = isGatewayProtocolResponseError(error);
    }
  }
  if (!isCurrent()) {
    return null;
  }
  created ??= (await reconcileAgentCreation(client, attempt)) ?? undefined;
  if (!isCurrent()) {
    return null;
  }
  if (attempts.get(target) === attempt) {
    attempts.delete(target);
  }
  if (!created) {
    throw attempt.rejection;
  }
  return created;
}

/** Creation-only roster work stays lazy; the capability owns synchronous provisional navigation. */
export async function createAgentInRoster(
  state: Pick<AgentsState, "agentsList" | "agentsError" | "recentlyCreatedAgentId">,
  loadList: () => Promise<AgentsListResult | null>,
  attempt: ReturnType<ReturnType<typeof createAgentCreationRecovery>["prepare"]>,
  isCurrent: () => boolean,
): Promise<AgentCreationResult | null> {
  if (!isCurrent()) {
    return null;
  }
  const previous = await loadList();
  if (!isCurrent()) {
    return null;
  }
  if (!previous) {
    throw new Error(state.agentsError || t("agentChip.rosterUnavailable"));
  }
  // The creation owner verifies inference with the opening message before
  // persistence, then returns the saved conversation in the same receipt.
  const created = await attempt.execute(isCurrent);
  if (!created || !isCurrent()) {
    return null;
  }
  // Publish the authoritative create receipt immediately. Config events own
  // the full roster refresh; opening this chat must not wait for another read.
  const current = state.agentsList ?? previous;
  const row = current.agents.find((agent) => agent.id === created.agentId) ?? {
    id: created.agentId,
    name: created.name,
  };
  state.agentsList = {
    ...current,
    agents: [row, ...current.agents.filter((agent) => agent.id !== created.agentId)],
  };
  state.recentlyCreatedAgentId = created.agentId;
  state.agentsError = null;
  return created;
}
