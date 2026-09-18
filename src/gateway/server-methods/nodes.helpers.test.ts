import { describe, expect, it, vi } from "vitest";
import {
  respondPreDispatchNodeInvokeError,
  respondUnavailableOnNodeInvokeErrorWithProvenance,
} from "./nodes.helpers.js";
import type { RespondFn } from "./types.js";

function createRespond(): ReturnType<typeof vi.fn<RespondFn>> {
  return vi.fn<RespondFn>();
}

describe("respondUnavailableOnNodeInvokeErrorWithProvenance", () => {
  it("propagates proven pre-dispatch provenance", () => {
    const respond = createRespond();

    expect(
      respondUnavailableOnNodeInvokeErrorWithProvenance(
        respond,
        {
          ok: false,
          error: { code: "NOT_CONNECTED", message: "node not connected" },
        },
        { nodeCommandDispatched: false },
      ),
    ).toBe(false);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        details: {
          nodeError: { code: "NOT_CONNECTED", message: "node not connected" },
          nodeCommandDispatched: false,
        },
      }),
    );
  });

  it.each(["TIMEOUT", "DISCONNECTED"])("propagates post-dispatch provenance for %s", (code) => {
    const respond = createRespond();

    respondUnavailableOnNodeInvokeErrorWithProvenance(
      respond,
      {
        ok: false,
        error: { code, message: "terminal node outcome" },
      },
      { nodeCommandDispatched: true },
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        details: {
          nodeError: { code, message: "terminal node outcome" },
          nodeCommandDispatched: true,
        },
      }),
    );
  });
});

describe("respondPreDispatchNodeInvokeError", () => {
  it("preserves request details and records that dispatch did not occur", () => {
    const respond = createRespond();

    respondPreDispatchNodeInvokeError(respond, "approval id does not match request", {
      code: "APPROVAL_REQUEST_MISMATCH",
      mismatchField: "argv",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        details: {
          code: "APPROVAL_REQUEST_MISMATCH",
          mismatchField: "argv",
          nodeCommandDispatched: false,
        },
      }),
    );
  });
});
