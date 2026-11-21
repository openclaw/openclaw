import { expect, it } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { createMessageActionRuntimeAuthority } from "./message-action-context.js";
import { createGatewayInflightFailure } from "./message-operation-result.js";
import { makeContext } from "./send.test-support.js";

it.each(["handoff", "authorization"] as const)(
  "preserves the structured channel refusal from %s",
  (source) => {
    const refusal = errorShape(
      ErrorCodes.FORBIDDEN,
      "Channel access was removed. Review the channel access settings.",
      { details: { reason: "CHANNEL_ACCESS_REMOVED" } },
    );
    const cause = new SessionMutationAuthorizationChangedError(refusal);
    const authority = createMessageActionRuntimeAuthority({
      client: null,
      request: { action: "send", params: {} },
      sessionMutationCommitGuard: () => {
        throw cause;
      },
    });
    const result = createGatewayInflightFailure(
      {
        context: makeContext(),
        dedupeKey: undefined,
        channel: "discord",
        err: source === "handoff" ? cause : new Error("Delivery preparation failed"),
      },
      () => authority.authorize(),
    );
    expect(result).toMatchObject({ ok: false, error: refusal });
  },
);
