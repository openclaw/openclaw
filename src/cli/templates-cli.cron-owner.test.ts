import { expect, it, vi } from "vitest";
import { retainGatewayResponsePayload } from "../../packages/gateway-client/src/protocol-request.js";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { captureTemplateCronOwner } from "./templates-cli.cron-owner.js";

it.each(["selected-profile", null])(
  "captures the authenticated creator %s before dispatch",
  async (profileId) => {
    const request = vi.fn();
    if (profileId) {
      request.mockResolvedValue({ profile: { id: profileId } });
    } else {
      const error = new GatewayClientRequestError({
        code: "FORBIDDEN",
        message: "users.self requires an authenticated user",
      });
      retainGatewayResponsePayload(error, undefined);
      request.mockRejectedValue(error);
    }
    const commitGuard = vi.fn();
    const captureOwnerProfileId = vi.fn();
    const signal = new AbortController().signal;
    const result = await captureTemplateCronOwner(request, signal, {
      commitGuard,
      captureOwnerProfileId,
    });
    expect(result).toEqual({ expectedProfileId: profileId });
    expect(request).toHaveBeenCalledExactlyOnceWith("users.self", {}, { signal });
    expect(commitGuard).toHaveBeenCalledTimes(2);
    expect(captureOwnerProfileId).toHaveBeenCalledExactlyOnceWith(profileId ?? undefined);
  },
);

it.each(["pending", "unavailable", "unbranded absence"])(
  "refuses %s identity without an ownership receipt",
  async (kind) => {
    const error = new GatewayClientRequestError({
      code: kind === "unavailable" ? "UNAVAILABLE" : "FORBIDDEN",
      message:
        kind === "unbranded absence"
          ? "users.self requires an authenticated user"
          : "Identity is unavailable",
    });
    if (kind !== "unbranded absence") {
      retainGatewayResponsePayload(error, undefined);
    }
    const captureOwnerProfileId = vi.fn();
    await expect(
      captureTemplateCronOwner(
        async () => {
          throw error;
        },
        new AbortController().signal,
        { captureOwnerProfileId },
      ),
    ).rejects.toBe(error);
    expect(captureOwnerProfileId).not.toHaveBeenCalled();
  },
);
