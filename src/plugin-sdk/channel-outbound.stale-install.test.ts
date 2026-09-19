import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGatewayInstallationReplacementHandler } from "../gateway/stale-install.js";
import { isRetryableDeliveryNotSentError } from "../infra/delivery-recovery.shared.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { deliverInboundReplyWithMessageSendContext } from "./channel-outbound.js";

const params: Parameters<typeof deliverInboundReplyWithMessageSendContext>[0] = {
  cfg: {},
  channel: "telegram",
  agentId: "main",
  ctxPayload: { CommandAuthorized: false, To: "synthetic-chat" },
  payload: { text: "Synthetic final reply" },
  info: { kind: "final" },
};

describe("durable reply runtime replacement", () => {
  let stopObserving: (() => void) | undefined;
  afterEach(() => {
    stopObserving?.();
    stopObserving = undefined;
    vi.doUnmock("../channels/turn/durable-delivery.js");
  });

  it("preserves retryable no-send proof when its own delivery chunk disappears", async () => {
    const onReplacement = vi.fn();
    stopObserving = registerGatewayInstallationReplacementHandler(onReplacement);
    const missingPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../dist/durable-delivery-missing.js",
    );
    const missingChunk = Object.assign(new Error(`ENOENT: open '${missingPath}'`), {
      code: "ENOENT",
      path: missingPath,
      syscall: "open",
    });
    vi.doMock("../channels/turn/durable-delivery.js", () => {
      throw missingChunk;
    });

    const error = await deliverInboundReplyWithMessageSendContext(params).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(isRetryableDeliveryNotSentError(error)).toBe(true);
    expect(onReplacement).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: expect.stringContaining("gateway.installation_replaced") }),
    );
  });

  it("does not claim no-send after the delivery runtime has started", async () => {
    const deliveryFailure = Object.assign(new Error("a later import failed after sending"), {
      code: "ENOENT",
      path: path.resolve("dist/durable-delivery-missing.js"),
    });
    vi.doMock("../channels/turn/durable-delivery.js", () => ({
      deliverInboundReplyWithMessageSendContextCore: async () => {
        throw deliveryFailure;
      },
    }));

    await expect(deliverInboundReplyWithMessageSendContext(params)).rejects.toBe(deliveryFailure);
    expect(isRetryableDeliveryNotSentError(deliveryFailure)).toBe(false);
  });
});
