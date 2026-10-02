import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../../agents/admitted-run-context.js";
import * as operatorRunAuthority from "../../operator-run-authority.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import type { CreateTalkRealtimeRelaySessionParams } from "../relay/state.js";
import type { TalkHandlerCallOptions } from "./prepared-call.test-support.js";
import { expectRespondError, expectRespondOk } from "./responses.test-support.js";

/** The relay factory adopts call custody while its setup request still owns the source. */
export function defineRelayOperatorAuthorityHandlerTests({
  callTalkHandler,
  mocks,
}: {
  callTalkHandler: (
    method: "talk.session.create",
    options: TalkHandlerCallOptions &
      Pick<GatewayRequestHandlerOptions, "hasCurrentClientAuthority">,
  ) => Promise<void>;
  mocks: {
    createTalkRealtimeRelaySession: Mock;
    resolveConfiguredRealtimeVoiceProvider: Mock;
  };
}) {
  it.each([false, true])(
    "transfers exact relay setup authority and releases the request hold (creation fails: %s)",
    async (creationFails) => {
      const events: string[] = [];
      const release = vi.fn(() => {
        events.push("release");
      });
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "operator-test",
        scopes: ["operator.write"],
        assertCurrent: () => {},
      });
      const capture = vi
        .spyOn(operatorRunAuthority, "captureGatewayOperatorRunAuthority")
        .mockImplementationOnce(async () => {
          events.push("capture");
          return { authority, release };
        });
      onTestFinished(() => capture.mockRestore());
      mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
        provider: { id: "openai", label: "OpenAI Realtime", createBridge: vi.fn() },
        providerConfig: {},
        capabilities: { transports: ["gateway-relay"], handlesAgentConsult: true },
      });
      mocks.createTalkRealtimeRelaySession.mockImplementationOnce(
        (params: CreateTalkRealtimeRelaySessionParams) => {
          events.push("create");
          expect(params.operatorAuthority).toBe(authority);
          expect(release).not.toHaveBeenCalled();
          if (creationFails) {
            throw new Error("relay construction failed");
          }
          return { relaySessionId: "relay-authority-test", provider: "openai" };
        },
      );
      const respond = vi.fn(() => {
        events.push("respond");
      });
      const hasCurrentClientAuthority = () => true;
      await callTalkHandler("talk.session.create", {
        params: { sessionKey: "main", mode: "realtime", transport: "gateway-relay" },
        respond,
        hasCurrentClientAuthority,
      });

      expect(capture).toHaveBeenCalledWith(expect.objectContaining({ hasCurrentClientAuthority }));
      expect(events).toEqual(["capture", "create", "respond", "release"]);
      expect(release).toHaveBeenCalledOnce();
      if (creationFails) {
        expectRespondError(respond, { message: "Error: relay construction failed" });
      } else {
        expectRespondOk(respond, { sessionId: "relay-authority-test" });
      }
    },
  );
}
