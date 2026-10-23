/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import { retainChatComposerMemoryFallback } from "./chat-composer-memory-fallback.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

const scope = { sessionKey: "global", agentId: "main" } as const;
const scopeKey = storedChatOutboxScopeKey(scope);
const bareGlobalKey = storedChatOutboxScopeKey({ sessionKey: "global" });

function storedAttachment(id: string, mimeType = "image/png"): ChatAttachment {
  return registerChatAttachmentPayload({
    attachment: { id, mimeType },
    dataUrl: `data:${mimeType};base64,${id}`,
    file: new File([id], id, { type: mimeType }),
  });
}

function globalHost(
  sibling: ChatAttachment,
  winning: ChatAttachment[] = [],
  attachments: ChatAttachment[] = [],
): ChatPageHost {
  return {
    agentsList: { defaultId: "main", mainKey: "main" },
    assistantAgentId: "main",
    chatAttachments: attachments,
    chatComposerFallbackByScope: {
      [bareGlobalKey]: {
        awaitingDefaults: true,
        message: "older sibling draft",
        attachments: [sibling],
        storageFailed: true,
        sequence: 1,
      },
      [scopeKey]: {
        message: "newest draft",
        attachments: [...winning],
        storageFailed: true,
        sequence: 2,
      },
    },
    hello: null,
    sessionKey: "global",
    settings: { gatewayUrl: "ws://example.test" },
  } as unknown as ChatPageHost;
}

it.each([false, true])(
  "adopts the newest fallback and releases only unowned payloads (live: %s)",
  (live) => {
    const sibling = storedAttachment("sibling");
    const winning = live ? [] : [storedAttachment("winning")];
    const host = globalHost(sibling, winning, live ? [sibling] : []);
    expect(
      retainChatComposerMemoryFallback(host, scope, {
        message: "newest draft",
        attachments: winning,
      }),
    ).toEqual({ sequence: 2 });
    expect(Object.keys(host.chatComposerFallbackByScope)).toEqual([scopeKey]);
    for (const attachment of [sibling, ...winning]) {
      expect(getChatAttachmentDataUrl({ id: attachment.id, mimeType: attachment.mimeType })).toBe(
        live || attachment !== sibling ? `data:image/png;base64,${attachment.id}` : null,
      );
    }
  },
);
