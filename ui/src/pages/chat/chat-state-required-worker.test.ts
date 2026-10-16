import { describe, expect, it, vi } from "vitest";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { revalidateChatMetadata } from "../../lib/chat/chat-metadata-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  readChatRequiredWorkerInferenceProfileId,
  refreshChatMetadata,
  retireChatMetadataRequests,
} from "./chat-state-refresh.ts";

function createMetadataState(request: ReturnType<typeof vi.fn>): ChatPageHost {
  return {
    ...makeChatHost(),
    agentsList: null,
    assistantAgentId: "main",
    client: { request },
    hello: { features: { methods: ["chat.metadata"] } },
    sessionKey: "agent:work:main",
  } as unknown as ChatPageHost;
}

describe("required worker chat metadata", () => {
  it.each(["session", "client", "epoch", "disconnect", "retire"] as const)(
    "retires the sync hint fact on %s changes",
    async (change) => {
      const request = vi.fn(async () => ({
        commands: [],
        models: [],
        requiredWorkerInferenceProfileId: "coding",
      }));
      const state = createMetadataState(request);
      try {
        await refreshChatMetadata(state);
        expect(readChatRequiredWorkerInferenceProfileId(state)).toBe("coding");
        if (change === "session") {
          state.sessionKey = "agent:work:second";
        }
        if (change === "client") {
          state.client = createTestGatewayClient(request);
        }
        if (change === "epoch") {
          state.connectionEpoch = (state.connectionEpoch ?? 0) + 1;
        }
        if (change === "disconnect") {
          state.connected = false;
        }
        if (change === "retire") {
          retireChatMetadataRequests(state);
        }
        expect(readChatRequiredWorkerInferenceProfileId(state)).toBeUndefined();
      } finally {
        retireChatMetadataRequests(state);
        state.sessions.dispose();
      }
    },
  );

  it("keeps the sync hint while policy is stale, missing or failed", async () => {
    let policy: { commands: never[]; requiredWorkerInferenceProfileId?: string } = {
      commands: [],
      requiredWorkerInferenceProfileId: "coding",
    };
    const request = vi.fn(async (method: string) =>
      method === "chat.metadata" ? policy : { models: [] },
    );
    const state = createMetadataState(request);
    try {
      await refreshChatMetadata(state);
      expect(readChatRequiredWorkerInferenceProfileId(state)).toBe("coding");
      policy = { commands: [] };
      invalidateChatMetadataStore(state.client!);
      expect(readChatRequiredWorkerInferenceProfileId(state)).toBeUndefined();
      await refreshChatMetadata(state);
      expect(readChatRequiredWorkerInferenceProfileId(state)).toBeUndefined();
      policy = { commands: [], requiredWorkerInferenceProfileId: "coding" };
      await revalidateChatMetadata(state.client!, {
        agentId: "work",
        sessionKey: state.sessionKey,
      });
      expect(readChatRequiredWorkerInferenceProfileId(state)).toBe("coding");
      request.mockImplementation(async (method) => {
        if (method === "chat.metadata") {
          throw new Error("Policy unavailable");
        }
        return { models: [] };
      });
      await revalidateChatMetadata(state.client!, {
        agentId: "work",
        sessionKey: state.sessionKey,
      }).catch(() => undefined);
      expect(readChatRequiredWorkerInferenceProfileId(state)).toBeUndefined();
    } finally {
      retireChatMetadataRequests(state);
      state.sessions.dispose();
    }
  });
});
