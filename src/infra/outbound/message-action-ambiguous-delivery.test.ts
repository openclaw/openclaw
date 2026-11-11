import { describe, expect, it } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
} from "../../../packages/gateway-protocol/src/gateway-error-details.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "./deliver-types.js";
import { projectAmbiguousDeliveryResult } from "./message-action-execution.js";

describe("projectAmbiguousDeliveryResult", () => {
  it("projects send evidence as unknown with do-not-resend", () => {
    const result = projectAmbiguousDeliveryResult(
      new OutboundDeliveryError("MatrixError: [429]", {
        cause: new Error("429"),
        sentBeforeError: true,
      }),
    );
    expect(result).toMatchObject({
      status: "delivery_unknown",
      delivered: false,
      sentBeforeError: true,
    });
    expect(result?.message).toContain("Do not resend it");
  });

  it("carries provider-accepted message IDs", () => {
    const result = projectAmbiguousDeliveryResult(
      new OutboundDeliveryError("partial", {
        cause: new Error("429"),
        results: [{ channel: "matrix", messageId: "evt-1" }],
      }),
    );
    expect(result?.message).toContain("evt-1");
  });

  it.each(["GatewayClientRequestError", "GatewayProtocolRequestError"])(
    "projects gateway-encoded ambiguity for %s",
    (name) => {
      const error = new GatewayClientRequestError({
        code: ErrorCodes.UNAVAILABLE,
        message: "relay failed",
        details: { code: GatewayErrorDetailCodes.OUTBOUND_DELIVERY_UNKNOWN },
      });
      error.name = name;
      const result = projectAmbiguousDeliveryResult(error);
      expect(result).toMatchObject({ status: "delivery_unknown", delivered: false });
      expect(result?.message).toContain("The gateway owns reconciliation");
    },
  );

  it("projects local held-custody errors as unknown", () => {
    // The queued projector is gateway-only; local held custody carries send
    // evidence, so it lands here instead of throwing. Recovery drain is
    // independent of the tool outcome.
    const error = new OutboundDeliveryError("held", {
      cause: new Error("429"),
      sentBeforeError: true,
    });
    error.queueCustody = "held";
    expect(projectAmbiguousDeliveryResult(error)).toMatchObject({
      status: "delivery_unknown",
      delivered: false,
    });
  });

  it("returns undefined for proven-not-sent errors", () => {
    expect(
      projectAmbiguousDeliveryResult(
        new PlatformMessageNotDispatchedError("rejected", {
          cause: new Error("policy"),
          retryable: false,
        }),
      ),
    ).toBeUndefined();
    expect(projectAmbiguousDeliveryResult(new Error("boom"))).toBeUndefined();
  });

  it("fails closed on mixed evidence and proof", () => {
    const error = new AggregateError(
      [
        new PlatformMessageNotDispatchedError("pre-connect", {
          cause: Object.assign(new Error("dns"), { code: "ENOTFOUND", syscall: "getaddrinfo" }),
        }),
        new OutboundDeliveryError("sent?", { cause: new Error("429"), sentBeforeError: true }),
      ],
      "mixed",
    );
    expect(projectAmbiguousDeliveryResult(error)).toMatchObject({
      status: "delivery_unknown",
    });
  });
});
