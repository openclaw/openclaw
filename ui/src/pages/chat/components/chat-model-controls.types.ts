import type { Element } from "solid-js";
import type { ChatAccountSelection } from "../../../../../packages/gateway-protocol/src/index.ts";
import type {
  CyberAccessProgram,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../../api/types.ts";
import type {
  ChatFastModePresentation,
  ChatFastModeSelectValue,
  ChatFastModeTarget,
} from "../../../lib/chat/model-select-state.ts";
import type { ChatThinkingTarget } from "../../../lib/chat/thinking.ts";
import type { ChatModelCatalogState } from "../../../lib/model-catalog-store.ts";
import type { ChatModelAccountSection } from "./chat-model-account-control.ts";
import type { ChatModelPickerTargetGroup } from "./chat-model-picker-options.ts";

type ChatContextWindowTarget = Pick<
  SessionsListResult["defaults"],
  "contextWindow" | "contextWindows" | "contextWindowDefault"
>;

export type ChatModelControlsProps = {
  modelAuthStatusResult?: ModelAuthStatusResult | null;
  accountSelection?: ChatAccountSelection | null;
  renderAccountSection?: (model: string) => ChatModelAccountSection | undefined;
  activeRunId: string | null;
  agentDefaultModel?: string;
  connected: boolean;
  gatewayAvailable: boolean;
  loading: boolean;
  modelCatalog: ModelCatalogEntry[];
  modelCatalogState: ChatModelCatalogState;
  /** Lets a lazy route wrap catalog status without adding its read to Chat boot. */
  renderModelCatalogStatus?: (render: () => Element) => Element;
  modelOverrides?: Readonly<Record<string, string | null | undefined>>;
  modelSelectionLocked?: boolean;
  modelSelectionTarget?: SessionsListResult["defaults"]["modelSelectionTarget"];
  modelPickerTargetGroups?: readonly ChatModelPickerTargetGroup[];
  modelPickerOpen?: boolean;
  modelSwitching: boolean;
  modelMutationDisabledReason?: string;
  effortMutationDisabledReason?: string;
  contextWindowMutationDisabledReason?: string;
  fastModeTarget?: ChatFastModeTarget;
  fastModeDisplay?: ChatFastModePresentation;
  accessProgramMutationDisabledReason?: string;
  requestedAccessProgram?: CyberAccessProgram;
  onAccessProgramSelect?: (value: CyberAccessProgram | null, sessionKey: string) => unknown;
  sending: boolean;
  sessionKey: string;
  selectedSession: SessionsListResult["sessions"][number] | undefined;
  selectedAgentRuntime?: string;
  sessionsResult: SessionsListResult | null;
  stream: string | null;
  contextWindowTarget?: ChatContextWindowTarget;
  thinkingDefaults?: SessionsListResult["defaults"];
  thinkingSession?: ChatThinkingTarget;
  onFastModeSelect?: (value: ChatFastModeSelectValue, sessionKey: string) => unknown;
  onContextWindowSelect?: (value: string, sessionKey: string) => unknown;
  onModelSetup?: () => void;
  onProviderSettings?: (provider: string) => void;
  onModelPickerOpen?: () => unknown;
  onModelPickerOpenChange?: (open: boolean) => void;
  onModelSelect?: (value: string, sessionKey: string, agentRuntime?: string | null) => unknown;
  onModelPickerTargetRetry?: (groupId: string) => unknown;
  onModelPickerTargetSelect?: (groupId: string, value: string) => unknown;
  onThinkingSelect?: (value: string, sessionKey: string) => unknown;
};
