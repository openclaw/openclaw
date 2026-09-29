// The owning dispatch suite supplies the scoped session-store mocks this fixture needs.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { MsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  emptyConfig,
  mocks,
  replyMediaPathMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  firstRouteReplyCall,
  globalBeforeAll0,
  installThreadingTestPlugin,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("reply media delivery ownership", () => {
  beforeEach(describe0BeforeEach0);

  it.each(["internal", "explicit", "inherited"] as const)(
    "keeps media staging with the actual %s reply owner",
    async (route) => {
      setNoAbort();
      mocks.routeReply.mockClear();
      installThreadingTestPlugin({ id: "imessage" });
      const dispatcher = createDispatcher();
      const original = "/workspace/chart.png";
      const staged = "/managed/chart.png";
      replyMediaPathMocks.createReplyMediaPathNormalizer.mockReturnValue(
        async (payload: ReplyPayload) => ({ ...payload, mediaUrls: [staged] }),
      );
      if (route === "inherited") {
        sessionStoreMocks.currentEntry = {
          sessionId: "media-owner",
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "imessage", to: "imessage:+15550001111" },
          }),
        };
      }
      const ctx = buildTestCtx({
        SessionKey: "agent:main:media-owner",
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: route === "inherited" ? undefined : "imessage",
        OriginatingTo: route === "inherited" ? undefined : "imessage:+15550001111",
        ExplicitDeliverRoute: route === "explicit",
        ...(route === "inherited"
          ? {
              InputProvenance: {
                kind: "inter_session" as const,
                sourceTool: "sessions_send",
                sourceSessionKey: "agent:main:source",
              },
            }
          : {}),
      });
      const replyResolver = async (_ctx: MsgContext, opts?: InternalGetReplyOptions) => {
        expect(opts?.mediaNormalizationOwner).toBe(route === "internal" ? "gateway" : undefined);
        return { text: "hi", mediaUrls: [original] };
      };
      await dispatchReplyFromConfig({
        ctx,
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
        replyOptions: { mediaNormalizationOwner: "gateway" },
      });
      if (route === "internal") {
        expect(mocks.routeReply).not.toHaveBeenCalled();
        expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
          expect.objectContaining({ mediaUrls: [original] }),
        );
      } else {
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
        expect(firstRouteReplyCall()).toMatchObject({
          channel: "imessage",
          to: "imessage:+15550001111",
          payload: { mediaUrls: [staged] },
        });
      }
    },
  );
});
