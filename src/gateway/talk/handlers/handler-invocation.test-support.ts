import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import * as gatewayWork from "../../../process/gateway-work-admission.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "../../server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "../../session-sharing-authorization-async.js";

type TalkHandlerCallOptions = {
  params: Record<string, unknown>;
  respond: RespondFn;
  config?: OpenClawConfig;
  context?: unknown;
  client?: unknown;
  id?: string;
};

export function createTalkHandlerCaller(talkHandlers: GatewayRequestHandlers) {
  return async function callTalkHandler(
    method: string,
    {
      params,
      respond,
      config = {},
      context = { getRuntimeConfig: () => config },
      client = { connId: "conn-1" },
      id = "1",
    }: TalkHandlerCallOptions,
  ) {
    const admission =
      method === "talk.client.create" ||
      method === "talk.session.create" ||
      method === "talk.client.toolCall"
        ? await resolveSessionMutationAuthorizationAsync({
            client: client as GatewayClient,
            context: context as GatewayRequestContext,
            method,
            requestParams: params,
          })
        : undefined;
    if (admission?.error) {
      respond(false, undefined, admission.error);
      return;
    }
    let catalogReleased: Promise<"settled" | "reset"> | undefined;
    const beginRootWork = gatewayWork.tryBeginGatewayIndependentRootWorkAdmission;
    const rootWorkSpy =
      method === "talk.catalog"
        ? vi
            .spyOn(gatewayWork, "tryBeginGatewayIndependentRootWorkAdmission")
            .mockImplementation((origin, options) => {
              const lease = beginRootWork(origin, options);
              if (!lease || origin !== "talk-catalog-refresh") {
                return lease;
              }
              return {
                ...lease,
                run: (run) =>
                  lease.run(() => {
                    const observeRelease = expectDefined(
                      gatewayWork.captureGatewayRootWorkReleaseObserver(),
                      "catalog refresh root release observer",
                    );
                    catalogReleased = new Promise((resolve) => {
                      observeRelease(resolve);
                    });
                    return run();
                  }),
              };
            })
        : undefined;
    try {
      const handler = expectDefined(
        talkHandlers[method],
        `talkHandlers["${method}"] test invariant`,
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        let warming = false;
        await handler({
          req: { type: "req", id, method },
          params: params as never,
          client: client as never,
          isWebchatConnect: () => false,
          respond: (...args) => {
            warming =
              method === "talk.catalog" &&
              asOptionalRecord(args[2]?.details)?.reason === "talk-catalog-warming";
            if (!warming || attempt === 1) {
              respond(...args);
            }
          },
          context: context as never,
          // Row creation is mocked here; talk-target.test covers the real post-ensure fence.
          ...(admission?.authorization
            ? {
                sessionMutationAuthorization: {
                  ...admission.authorization,
                  assertTargetCurrent: vi.fn(),
                },
              }
            : {}),
        });
        if (!warming || attempt === 1) {
          break;
        }
        // A clock turn cannot join credential reads or provider discovery owned by this root.
        await catalogReleased;
      }
    } finally {
      try {
        await catalogReleased;
      } finally {
        rootWorkSpy?.mockRestore();
        admission?.authorization?.release?.();
      }
    }
  };
}
