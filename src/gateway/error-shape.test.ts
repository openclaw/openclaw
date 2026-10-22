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

it.each([
  Object.assign(new Error("write failed"), { code: "SQLITE_FULL" }),
  Object.assign(new Error("write failed"), { code: "ERR_SQLITE_ERROR", errcode: 13 }),
  new Error("database or disk is full"),
  new Error("cleanup failed", {
    cause: Object.assign(new Error("write failed"), { code: "ENOSPC" }),
  }),
])("classifies a disk-full failure without exposing internal text: %s", (error) => {
  expect(
    errorShapeFromError(ErrorCodes.INVALID_REQUEST, error, { message: "internal handler failure" }),
  ).toMatchObject({
    code: ErrorCodes.UNAVAILABLE,
    message:
      "OpenClaw couldn't save your conversation because the disk is full. Free up space on the computer running OpenClaw before continuing.",
    retryable: true,
    details: { code: "SQLITE_FULL" },
  });
});
