/**
 * Public SDK facade for channel-agnostic direct-message (1:1) peer binding
 * helpers. Channels use these to compile and match bindings that target a
 * single peer rather than a group/topic.
 */
export type {
  DirectPeerConversationMatch,
  DirectPeerConversationRef,
  NormalizePeerId,
} from "../channels/plugins/direct-peer-binding.js";
export {
  compileDirectPeerConversation,
  isDirectPeerBinding,
  matchDirectPeerConversation,
} from "../channels/plugins/direct-peer-binding.js";
