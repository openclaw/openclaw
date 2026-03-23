import { describe, expect, it } from "vitest";
import { ReplayControlError, toHttpErrorResponse } from "./errors.js";

describe("replay control errors", () => {
  it("maps typed errors to stable http payload", () => {
    const err = new ReplayControlError({
      code: "not_found",
      status: 404,
      message: "Run not found",
    });
    expect(toHttpErrorResponse(err)).toEqual({
      status: 404,
      body: {
        ok: false,
        error: {
          code: "not_found",
          message: "Run not found",
        },
      },
    });
  });
});
