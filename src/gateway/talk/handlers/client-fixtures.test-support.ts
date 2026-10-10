import path from "node:path";
import { vi } from "vitest";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "../../server-methods/types.js";

export function createTrustedInternalChatSendFixture(chatSend: (...args: unknown[]) => unknown) {
  return (
    request: GatewayRequestHandlerOptions,
    onAdmissionOwned: unknown,
    options: {
      beforeDispatch?: (params: {
        runId: string;
        assertCurrent: () => void;
        assertWorkAdmissionCurrent: () => void;
      }) => Promise<void | (() => void)>;
    },
  ) => {
    request.context.chatAbortControllers ??= new Map();
    let registration: Promise<void | (() => void)> | undefined;
    const result = chatSend(
      {
        ...request,
        respond: (...args: Parameters<RespondFn>) => {
          const [ok, payload] = args;
          const acknowledgement = payload as { runId?: string; status?: string } | undefined;
          if (
            ok &&
            acknowledgement?.runId &&
            (!acknowledgement.status || acknowledgement.status === "started")
          ) {
            registration = options.beforeDispatch?.({
              runId: acknowledgement.runId,
              assertCurrent() {},
              assertWorkAdmissionCurrent() {},
            });
          }
          if (registration) {
            void registration.then(
              () => request.respond(...args),
              (error: unknown) =>
                request.respond(false, undefined, {
                  code: ErrorCodes.UNAVAILABLE,
                  message: String(error),
                }),
            );
          } else {
            request.respond(...args);
          }
        },
      },
      onAdmissionOwned,
      options,
    );
    return Promise.resolve(result).then(() => registration);
  };
}

export function createBrowserProvider(
  createBrowserSession: NonNullable<RealtimeVoiceProviderPlugin["createBrowserSession"]>,
) {
  return {
    id: "openai",
    label: "OpenAI Realtime",
    isConfigured: () => true,
    createBrowserSession,
    createBridge: vi.fn(),
  };
}

export function createBrowserSessionMock() {
  return vi.fn(async (_input: unknown) => ({
    provider: "openai",
    transport: "webrtc" as const,
    clientSecret: "secret",
  }));
}

export type BrowserRequest = Parameters<
  NonNullable<RealtimeVoiceProviderPlugin["createBrowserSession"]>
>[0];
export const browserSession = {
  provider: "openai",
  transport: "webrtc" as const,
  clientSecret: "test-pending-offer",
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
      chatAbortControllers: new Map(),
      logGateway: { warn: vi.fn() },
      broadcastToConnIds: vi.fn(),
    },
  };
}
