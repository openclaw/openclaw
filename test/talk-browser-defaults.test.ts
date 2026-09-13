// @vitest-environment node
import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "../extensions/openai/api.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { withLocalGatewayRequestScope } from "../src/gateway/local-request-context.js";
import { talkHandlers } from "../src/gateway/talk/handlers/index.js";
import { getPluginRuntimeGatewayRequestScope } from "../src/plugins/runtime/gateway-request-scope.js";
import type { RealtimeVoiceProviderPlugin } from "../src/plugins/types.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import type { GatewayBrowserClient } from "../ui/src/api/gateway.js";
import { useRealtimeTalkMicrophoneFixture } from "../ui/src/pages/chat/talk/input.test-support.js";
import { RealtimeTalkSession } from "../ui/src/pages/chat/talk/session.js";
import type { RealtimeTalkTransport } from "../ui/src/pages/chat/talk/shared.js";

const mocks = vi.hoisted(() => ({
  providers: [] as RealtimeVoiceProviderPlugin[],
  providerRequests: [] as Array<{ model?: string; tools?: unknown[] }>,
  createSession: vi.fn(),
}));

vi.mock("../src/talk/provider-registry.js", () => ({
  canonicalizeRealtimeVoiceProviderId: (id: string | undefined) => {
    const normalized = id?.trim().toLowerCase();
    return (
      mocks.providers.find(
        (provider) => provider.id === normalized || provider.aliases?.includes(normalized ?? ""),
      )?.id ?? normalized
    );
  },
  getRealtimeVoiceProvider: (id: string) =>
    mocks.providers.find(
      (provider) =>
        provider.id === id.trim().toLowerCase() ||
        provider.aliases?.includes(id.trim().toLowerCase()),
    ),
  listRealtimeVoiceProviders: () => mocks.providers,
}));
vi.mock("../src/tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: (id: string | undefined) => id,
  getSpeechProvider: () => undefined,
  listSpeechProviders: () => [],
}));
vi.mock("../src/realtime-transcription/provider-registry.js", () => ({
  canonicalizeRealtimeTranscriptionProviderId: (id: string | undefined) => id,
  getRealtimeTranscriptionProvider: () => undefined,
  listRealtimeTranscriptionProviders: () => [],
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: async ({ init }: { init: RequestInit }) => {
    const body = (await new Response(init.body).json()) as {
      session: { model?: string; tools?: unknown[] };
    };
    mocks.providerRequests.push(body.session);
    return {
      response: new Response(JSON.stringify({ value: "test-ephemeral-secret" })),
      release: async () => undefined,
    };
  },
}));
vi.mock("../src/agents/realtime-bootstrap-context.js", () => ({
  resolveRealtimeBootstrapContextInstructions: async () => undefined,
}));
vi.mock("../src/gateway/talk/client-agent-consult.js", () => ({
  createTalkClientAgentConsultRunner: () => ({
    runArgs: async () => ({ text: "Done" }),
    runOwnedArgs: async () => ({ text: "Done" }),
    runPrompt: async () => ({ text: "Done" }),
    getToolAuthorityOverlay: () => undefined,
  }),
}));
vi.mock("../src/gateway/talk/client-gateway-control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/gateway/talk/client-gateway-control.js")>()),
  createTalkClientGatewayControlOwner: () => ({
    control: { bindBridge: () => undefined },
    runAgentConsult: async () => ({ text: "Done" }),
    assertOpen: () => undefined,
    adoptProvider: async () => undefined,
    activate: () => undefined,
    close: async () => undefined,
  }),
}));
vi.mock("../src/talk/client-voice-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/talk/client-voice-session.js")>()),
  resolveClientVoiceAgentSessionId: () => undefined,
  ensureClientVoiceAgentSessionEntry: async () => "test-agent-session",
  createOrResumeClientVoiceSession: () => "test-voice-session",
  closeStaleClientVoiceSessions: async () => 0,
}));
vi.mock("../ui/src/pages/chat/talk/transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/src/pages/chat/talk/transport.js")>()),
  createRealtimeTalkTransport: (): RealtimeTalkTransport => ({
    start: async () => "ready",
    stop: () => undefined,
    setVideoEnabled: async () => undefined,
  }),
}));

useRealtimeTalkMicrophoneFixture();
beforeEach(() => {
  mocks.providerRequests.length = 0;
  mocks.createSession.mockReset();
});

describe("OpenAI browser Talk catalog defaults", () => {
  it.each([
    {
      label: "unpinned browser",
      model: undefined,
      camera: false,
      expected: "gpt-live-1",
    },
    { label: "explicit GA", model: "gpt-realtime-2.1", camera: true, expected: "gpt-realtime-2.1" },
    { label: "explicit Live", model: "gpt-live-1", camera: false, expected: "gpt-live-1" },
    {
      label: "Live launch over configured GA",
      model: "gpt-realtime-2.1",
      launchModel: "gpt-live-1",
      camera: false,
      expected: "gpt-live-1",
    },
    {
      label: "GA launch over configured Live",
      model: "gpt-live-1",
      launchModel: "gpt-realtime-2.1",
      camera: true,
      expected: "gpt-realtime-2.1",
    },
    {
      label: "GA launch through a provider alias",
      model: "gpt-live-1",
      launchModel: "gpt-realtime-2.1",
      launchProvider: " OPENAI-VOICE ",
      camera: true,
      expected: "gpt-realtime-2.1",
    },
    {
      label: "audio-only browser",
      model: undefined,
      camera: false,
      expected: "gpt-live-1",
      audioOnly: true,
    },
  ])(
    "preserves $label from discovery through session creation",
    async ({ model, launchModel, launchProvider, camera, expected, audioOnly }) => {
      await withOpenClawTestState({ prefix: "talk-browser-defaults-" }, async (state) => {
        const cfg: OpenClawConfig = {
          agents: {
            list: [{ id: "main", agentDir: state.agentDir(), workspace: state.workspaceDir }],
          },
          talk: {
            agentId: "main",
            realtime: {
              provider: "openai",
              ...(model ? { model } : {}),
              providers: { openai: { apiKey: "test-platform-key" } },
            },
          },
        };
        const provider = buildOpenAIRealtimeVoiceProvider({
          quicksilverBrowserSessionBroker: {
            capabilities: { handlesAgentConsult: true },
            createBrowserSession: async (request) => {
              mocks.providerRequests.push({ model: request.model });
              return {
                provider: "openai",
                transport: "webrtc",
                model: request.model,
                offerUrl: "/test-offer",
                clientSecret: "",
              };
            },
            cancelBrowserSession: async () => undefined,
          },
        });
        provider.aliases = ["openai-voice"];
        mocks.providers = [
          provider,
          {
            id: "other",
            label: "Other voice provider",
            isConfigured: ({ providerConfig }) => providerConfig.model === model,
            createBridge: () => {
              throw new Error("unused");
            },
          },
        ];
        const catalogs: TalkCatalogResult[] = [];
        const request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
          if (method === "talk.client.close") {
            return {} as T;
          }
          const handler = talkHandlers[method];
          if (!handler) {
            throw new Error(`Unexpected method ${method}`);
          }
          if (method === "talk.client.create") {
            mocks.createSession(params);
          }
          let payload: unknown;
          let failure: string | undefined;
          await withLocalGatewayRequestScope(
            { deps: {}, getRuntimeConfig: () => cfg },
            async () => {
              const context = getPluginRuntimeGatewayRequestScope()?.context;
              if (!context) {
                throw new Error("Local Gateway context was not installed");
              }
              await handler({
                req: { type: "req", id: method, method },
                params,
                client: {
                  connId: "camera-defaults",
                  connect: {
                    minProtocol: 3,
                    maxProtocol: 3,
                    client: {
                      id: "openclaw-control-ui",
                      version: "test",
                      platform: "web",
                      mode: "webchat",
                    },
                    scopes: ["operator.admin"],
                  },
                },
                isWebchatConnect: () => false,
                respond: (ok, value, error) => {
                  if (!ok) {
                    failure = error?.message ?? "Talk request failed";
                  }
                  payload = value;
                },
                context,
                sessionMutationAuthorization: {
                  talkSessionTarget: {
                    agentId: "main",
                    sessionKey: "agent:main:main",
                    canonicalKey: "agent:main:main",
                    storePath: state.sessionsDir(),
                  },
                  assertCurrent: () => undefined,
                  assertTargetCurrent: () => undefined,
                },
              });
            },
          );
          if (failure) {
            throw new Error(failure);
          }
          if (method === "talk.catalog") {
            catalogs.push(payload as TalkCatalogResult);
          }
          return payload as T;
        };
        const onVideoCapability = vi.fn();
        const session = new RealtimeTalkSession(
          { request } as GatewayBrowserClient,
          "agent:main:main",
          audioOnly ? {} : { onVideoCapability },
          launchModel ? { provider: launchProvider ?? "openai", model: launchModel } : {},
        );
        try {
          await session.start();
          expect(mocks.createSession).toHaveBeenCalledWith({
            sessionKey: "agent:main:main",
            ...(launchModel ? { provider: launchProvider ?? "openai", model: launchModel } : {}),
            capabilities: camera
              ? ["voice-transcript", "voice-selection", "camera-frame"]
              : ["voice-transcript", "voice-selection"],
          });
          expect(mocks.providerRequests).toHaveLength(1);
          expect(mocks.providerRequests[0]?.model).toBe(expected);
          if (!audioOnly) {
            expect(onVideoCapability).toHaveBeenCalledWith(camera);
            expect(catalogs[0]?.realtime.providers).toContainEqual(
              expect.objectContaining({ id: "other", configured: true }),
            );
          }
          if (camera) {
            expect(mocks.providerRequests[0]?.tools).toContainEqual(
              expect.objectContaining({ name: "describe_view" }),
            );
          }
        } finally {
          session.stop();
        }
      });
    },
  );
});
