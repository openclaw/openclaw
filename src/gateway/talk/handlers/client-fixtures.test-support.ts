import path from "node:path";
import { vi } from "vitest";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import type { ChatSendInternalOptions } from "../../server-methods/chat-send-options.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "../../server-methods/types.js";

type BrowserSessionFactory = NonNullable<RealtimeVoiceProviderPlugin["createBrowserSession"]>;

export function createTrustedInternalChatSendFixture(chatSend: (...args: unknown[]) => unknown) {
  return (
    request: GatewayRequestHandlerOptions,
    onAdmissionOwned: unknown,
    options: Pick<ChatSendInternalOptions, "beforeDispatch">,
  ) => {
    let registration: Promise<void | (() => void)> | undefined;
    return Promise.resolve(
      chatSend(
        {
          ...request,
          respond: (...args: Parameters<RespondFn>) => {
            const [ok, payload] = args;
            const { runId, status } = (payload ?? {}) as { runId?: string; status?: string };
            if (ok && runId && (!status || status === "started")) {
              registration = options.beforeDispatch?.({
                runId,
                assertCurrent() {},
                assertWorkAdmissionCurrent() {},
              });
            }
            const respond = () => request.respond(...args);
            return registration
              ? void registration.then(respond, (error: unknown) =>
                  request.respond(false, undefined, {
                    code: ErrorCodes.UNAVAILABLE,
                    message: String(error),
                  }),
                )
              : respond();
          },
        },
        onAdmissionOwned,
        options,
      ),
    ).then(() => registration);
  };
}

export function createBrowserProvider(createBrowserSession: BrowserSessionFactory) {
  return {
    id: "openai",
    label: "OpenAI Realtime",
    isConfigured: () => true,
    createBrowserSession,
    createBridge: vi.fn(),
  };
}

function browserCredentials(clientSecret: string) {
  return { provider: "openai", transport: "webrtc" as const, clientSecret };
}

export function createBrowserSessionMock() {
  return vi.fn(async (_input: unknown) => browserCredentials("secret"));
}

export type BrowserRequest = Parameters<BrowserSessionFactory>[0];
export const browserSession = {
  ...browserCredentials("test-pending-offer"),
  offerUrl: "/plugins/openai/realtime/calls",
};

export function createDelegatedBrowserProviderFixture(
  createBrowserSession: (request: BrowserRequest) => Promise<typeof browserSession>,
  tempDir: string,
) {
  const cancelBrowserSession = vi.fn(async () => undefined);
  const provider = {
    id: "openai",
    capabilities: { transports: ["webrtc"], handlesAgentConsult: true, supportsToolCalls: false },
    createBrowserSession,
  };
  Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
    value: { isBrowserSessionConfigured: () => true, cancelBrowserSession },
  });
  const client = { connId: "conn-close" };
  const clients = new Set([client]);
  return {
    provider,
    cancelBrowserSession,
    client,
    clients,
    context: {
      getRuntimeConfig: () => ({
        agents: { defaults: { workspace: path.join(tempDir, "workspace") } },
      }),
      getClientConnIds: (filter?: (candidate: typeof client) => boolean) =>
        new Set(
          [...clients]
            .filter((candidate) => !filter || filter(candidate))
            .map((candidate) => candidate.connId),
        ),
      logGateway: { warn: vi.fn() },
      broadcastToConnIds: vi.fn(),
    },
  };
}

/** Wait for the requested event while surfacing any earlier handler failure. */
export function observeTalkVoiceChangeRequest(
  broadcast: ReturnType<
    typeof createDelegatedBrowserProviderFixture
  >["context"]["broadcastToConnIds"],
) {
  const requested = createDeferred();
  broadcast.mockImplementation((event) => {
    if (event === "talk.voice.change") {
      requested.resolve();
    }
  });
  return (operation: PromiseLike<unknown>) =>
    awaitGateBeforeSettlement(
      requested.promise,
      operation,
      "Voice change finished before requesting a replacement",
    );
}
