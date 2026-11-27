import type {
  ChannelCapabilities,
  ChannelMessagingAdapter,
} from "../../channels/plugins/types.public.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

const resolveSessionConversationStub: NonNullable<
  ChannelMessagingAdapter["resolveSessionConversation"]
> = ({ rawId }) => ({ id: rawId });
const resolveSessionTargetStub: NonNullable<ChannelMessagingAdapter["resolveSessionTarget"]> = ({
  kind,
  id,
  threadId,
}) => (threadId ? `${kind}:${id}:thread:${threadId}` : `${kind}:${id}`);

export function createSessionsChannelTestRegistry(
  channels: readonly {
    id: string;
    label: string;
    chatTypes: ChannelCapabilities["chatTypes"];
    preferSessionLookupForAnnounceTarget?: boolean;
    resolveConversation?: boolean;
  }[],
) {
  return createTestRegistry(
    channels.map(
      ({
        id,
        label,
        chatTypes,
        preferSessionLookupForAnnounceTarget,
        resolveConversation = true,
      }) => ({
        pluginId: id,
        source: "test",
        plugin: {
          id,
          meta: {
            id,
            label,
            selectionLabel: label,
            docsPath: `/channels/${id}`,
            blurb: `${label} test stub.`,
            ...(preferSessionLookupForAnnounceTarget
              ? { preferSessionLookupForAnnounceTarget: true }
              : {}),
          },
          capabilities: { chatTypes },
          messaging: {
            ...(resolveConversation
              ? { resolveSessionConversation: resolveSessionConversationStub }
              : {}),
            resolveSessionTarget: resolveSessionTargetStub,
          },
          config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
        },
      }),
    ),
  );
}
