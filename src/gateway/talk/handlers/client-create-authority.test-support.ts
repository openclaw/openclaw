import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import { createAdmittedRunOperatorAuthority } from "../../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import * as operatorRunAuthority from "../../operator-run-authority.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import type { TalkHandlerCallOptions } from "./prepared-call.test-support.js";
import { expectRespondError, expectRespondOk } from "./responses.test-support.js";

/** The browser setup handler transfers request custody only to Gateway-owned calls. */
export function defineBrowserOperatorAuthorityTests({
  callTalkHandler,
  createBrowserProvider,
  createBrowserSessionMock,
  mocks,
}: {
  callTalkHandler: (
    method: "talk.client.create",
    options: TalkHandlerCallOptions &
      Pick<GatewayRequestHandlerOptions, "hasCurrentClientAuthority">,
  ) => Promise<void>;
  createBrowserProvider: (create: Mock) => RealtimeVoiceProviderPlugin;
  createBrowserSessionMock: () => Mock;
  mocks: {
    createTalkClientGatewayControlOwner: Mock;
    resolveConfiguredRealtimeVoiceProvider: Mock;
  };
}) {
  it.each([false, true])(
    "retains setup authority until the browser call closes (native delegation: %s)",
    async (handlesAgentConsult) => {
      const release = vi.fn();
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "operator-test",
        scopes: ["operator.write"],
        assertCurrent: () => {},
      });
      const capture = vi
        .spyOn(operatorRunAuthority, "captureGatewayOperatorRunAuthority")
        .mockResolvedValueOnce({ authority, release });
      onTestFinished(() => capture.mockRestore());
      const lifetime = new AbortController();
      const createOwner = expectDefined(
        mocks.createTalkClientGatewayControlOwner.getMockImplementation(),
        "browser control owner fixture",
      );
      mocks.createTalkClientGatewayControlOwner.mockImplementationOnce((params) => ({
        ...createOwner(params),
        signal: lifetime.signal,
      }));
      const createBrowserSession = createBrowserSessionMock();
      mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
        provider: createBrowserProvider(createBrowserSession),
        providerConfig: {},
        capabilities: { handlesAgentConsult, supportsGatewayControl: true },
      });
      const respond = vi.fn();
      const hasCurrentClientAuthority = () => true;
      await callTalkHandler("talk.client.create", {
        params: {
          sessionKey: "main",
          ...(handlesAgentConsult ? {} : { capabilities: ["gateway-control-v1"] }),
        },
        hasCurrentClientAuthority,
        respond,
      });

      expectRespondOk(respond, { provider: "openai", transport: "webrtc" });
      expect(capture).toHaveBeenCalledWith(expect.objectContaining({ hasCurrentClientAuthority }));
      expect(release).not.toHaveBeenCalled();
      lifetime.abort();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each(["owner construction", "provider startup"])(
    "releases captured browser authority if %s fails",
    async (failure) => {
      const release = vi.fn();
      const capture = vi
        .spyOn(operatorRunAuthority, "captureGatewayOperatorRunAuthority")
        .mockResolvedValueOnce({
          authority: createAdmittedRunOperatorAuthority({
            profileId: "operator-test",
            scopes: ["operator.write"],
            assertCurrent: () => {},
          }),
          release,
        });
      onTestFinished(() => capture.mockRestore());
      const createBrowserSession = createBrowserSessionMock();
      if (failure === "owner construction") {
        mocks.createTalkClientGatewayControlOwner.mockImplementationOnce(() => {
          throw new Error("owner construction failed");
        });
      } else {
        createBrowserSession.mockRejectedValueOnce(new Error("provider startup failed"));
      }
      mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
        provider: createBrowserProvider(createBrowserSession),
        providerConfig: {},
        capabilities: { handlesAgentConsult: true },
      });
      const respond = vi.fn();
      await callTalkHandler("talk.client.create", {
        params: { sessionKey: "main" },
        respond,
        context: { getRuntimeConfig: () => ({}), logGateway: { warn: vi.fn() } },
      });

      expectRespondError(respond, { message: `Error: ${failure} failed` });
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("fails a requested Gateway-owned session without provider/auth support", async () => {
    const createBrowserSession = vi.fn();
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider: createBrowserProvider(createBrowserSession),
      providerConfig: { model: "gpt-realtime-2.1" },
      capabilities: {
        transports: ["webrtc"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        supportsToolCalls: true,
      },
    });
    const respond = vi.fn();

    await callTalkHandler("talk.client.create", {
      params: { sessionKey: "main", capabilities: ["gateway-control-v1"] },
      respond,
      config: { talk: { realtime: { provider: "openai" } } } as OpenClawConfig,
    });

    expect(createBrowserSession).not.toHaveBeenCalled();
    expect(mocks.createTalkClientGatewayControlOwner).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: ErrorCodes.UNAVAILABLE,
      message:
        'Realtime provider "openai" does not support gateway-control-v1 with its configured authentication',
    });
  });
}
