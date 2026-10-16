import type { GatewayAgentRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { AgentIdentityCapability } from "../../lib/agents/identity.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { NewSessionRouteData } from "./location.ts";

export type AgentSelectOptions = {
  agents: GatewayAgentRow[];
  agentId: string;
  agentIdentity?: AgentIdentityCapability;
  disabled: boolean;
  variant?: "default" | "compact";
  onSelect: (agentId: string) => void;
  onOpenChange: (open: boolean) => void;
};

export type NewSessionPlaceControlsOptions = {
  context: ApplicationContext | undefined;
  data: NewSessionRouteData | undefined;
  gateway: DraftGatewayState;
  place: DraftPlaceState;
  submitting: boolean;
  pendingPlacement: boolean;
  onConnectMachine: () => void;
  onNavigate: ApplicationContext["navigate"];
  onFocusComposer: () => void;
  requestUpdate: () => void;
};
