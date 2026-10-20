/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
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
        attachments: winning,
        storageFailed: true,
        sequence: 2,
      },
    },
    hello: null,
    sessionKey: "global",
    settings: { gatewayUrl: "ws://example.test" },
  } as unknown as ChatPageHost;
}

describe("chat composer memory fallback adoption", () => {
  it("releases losing sibling fallback payloads when adoption drops them", () => {
    const losing = storedAttachment("losing-sibling-attachment");
    const winning = storedAttachment("winning-attachment");
    const host = globalHost(losing, [winning]);

    const ownership = retainChatComposerMemoryFallback(host, scope, {
      message: "newest draft",
      attachments: [winning],
    });

    expect(ownership).toEqual({ sequence: 2 });
    expect(Object.keys(host.chatComposerFallbackByScope)).toEqual([scopeKey]);
    expect(getChatAttachmentDataUrl({ id: losing.id, mimeType: losing.mimeType })).toBeNull();
    expect(getChatAttachmentDataUrl({ id: winning.id, mimeType: winning.mimeType })).toBe(
      "data:image/png;base64,winning-attachment",
    );
  });

  it("keeps payloads shared with the live composer when a sibling is dropped", () => {
    const shared = storedAttachment("shared-with-composer");
    const host = globalHost(shared, [], [shared]);

    retainChatComposerMemoryFallback(host, scope, {
      message: "newest draft",
      attachments: [],
    });

    expect(getChatAttachmentDataUrl({ id: shared.id, mimeType: shared.mimeType })).toBe(
      "data:image/png;base64,shared-with-composer",
    );
  });
});
