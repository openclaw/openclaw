// Focused public test contracts for native agent-runtime adapters.

export { setHostToolFactoryForTest } from "./test-helpers/agents/host-tool-factory.js";
export {
  AUTH_PROFILE_RUNTIME_CONTRACT,
  createAuthAliasManifestRegistry,
  expectedForwardedAuthProfile,
} from "./test-helpers/agents/auth-profile-runtime-contract.js";
export { DELIVERY_NO_REPLY_RUNTIME_CONTRACT } from "./test-helpers/agents/delivery-no-reply-runtime-contract.js";
export {
  createFileBackedSessionManagerForTest,
  openFileBackedSessionManagerForTest,
} from "./test-helpers/agents/session-manager-file-fixture.js";
export {
  buildContractReplyPayloads,
  createContractToolTerminalObserver,
  createHostTtsRuntimeContract,
  createOwnerBackedContractTool,
  createProcessPollDeliveryContract,
  createTerminalPresentationContractTool,
  installCodexToolResultMiddleware,
  installOpenClawOwnedToolHooks,
  mediaToolResult,
  resetOpenClawOwnedToolHooks,
  textToolResult,
} from "./test-helpers/agents/openclaw-owned-tool-runtime-contract.js";
export {
  createContractFallbackConfig,
  createContractRunResult,
  OUTCOME_FALLBACK_RUNTIME_CONTRACT,
} from "./test-helpers/agents/outcome-fallback-runtime-contract.js";
export {
  CODEX_CONTRACT_PROVIDER_ID,
  codexPromptOverlayContext,
  GPT5_CONTRACT_MODEL_ID,
  GPT5_PREFIXED_CONTRACT_MODEL_ID,
  NON_GPT5_CONTRACT_MODEL_ID,
  NON_OPENAI_CONTRACT_PROVIDER_ID,
  OPENAI_CODEX_CONTRACT_PROVIDER_ID,
  OPENAI_CONTRACT_PROVIDER_ID,
  openAiPluginPersonalityConfig,
  sharedGpt5PersonalityConfig,
} from "./test-helpers/agents/prompt-overlay-runtime-contract.js";
export {
  createNativeOpenAICodexResponsesModel,
  createNativeOpenAIResponsesModel,
  createParameterFreeTool,
  createPermissiveTool,
  createProxyOpenAIResponsesModel,
  createStrictCompatibleTool,
  normalizedParameterFreeSchema,
} from "./test-helpers/agents/schema-normalization-runtime-contract.js";
export {
  assistantHistoryMessage,
  currentPromptHistoryMessage,
  inlineDataUriOrphanLeaf,
  mediaOnlyHistoryMessage,
  QUEUED_USER_MESSAGE_MARKER,
  structuredHistoryMessage,
  structuredOrphanLeaf,
  textOrphanLeaf,
} from "./test-helpers/agents/transcript-repair-runtime-contract.js";

export { buildEmbeddedRunPayloads } from "../agents/embedded-agent-runner/run/payloads.js";
export { subscribeEmbeddedAgentSession } from "../agents/embedded-agent-subscribe.js";
export {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../agents/sessions/agent-session-loop-correctness.test-support.js";
export { createReadToolDefinition } from "../agents/sessions/tools/read.js";
export { createSubscribedSessionHarness } from "../agents/embedded-agent-subscribe.e2e-harness.js";
export { createAssistantOutput } from "../../packages/ai/src/transports/assistant-output.js";
