import { expect, it } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { IncognitoSessionEndedError } from "../state/incognito-session-error.js";
import { errorShapeFromError } from "./error-shape.js";

it("reports ended incognito sessions as typed nonretryable client failures through cleanup wrappers", () => {
  const ended = new IncognitoSessionEndedError();
  const error = new AggregateError([new Error("cleanup"), ended], "operation failed");
  expect(
    errorShapeFromError(ErrorCodes.INVALID_REQUEST, error, {
      message: "generic failure",
      retryable: true,
    }),
  ).toMatchObject({
    code: ErrorCodes.UNAVAILABLE,
    message: ended.message,
    retryable: false,
    details: { code: "INCOGNITO_SESSION_ENDED" },
  });
});
