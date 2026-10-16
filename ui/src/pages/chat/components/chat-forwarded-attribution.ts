import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { solidContent } from "../../../lit/solid-content.tsx";
import {
  ForwardedAttribution,
  type ForwardedAttributionOptions,
} from "./chat-forwarded-attribution.tsx";

export function renderForwardedAttribution(
  group: Pick<MessageGroup, "senderSession"> & Partial<Pick<MessageGroup, "messages">>,
  opts: ForwardedAttributionOptions,
) {
  return solidContent(ForwardedAttribution, { group, options: opts });
}
