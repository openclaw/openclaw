import { ErrorCodes } from "../protocol/index.js";

/**
 * Thrown by decodeCursor when the cursor value is malformed or encodes a non-positive integer.
 * @see #74706
 */
export class CursorError extends Error {
  readonly code = ErrorCodes.INVALID_REQUEST;
  constructor(message = "malformed cursor") {
    super(message);
    this.name = "CursorError";
  }
}

/**
 * Encode a messageSeq number as an opaque base64url cursor string.
 * @see #74706
 */
export function encodeCursor(seq: number): string {
  return Buffer.from(String(seq)).toString("base64url");
}

/**
 * Decode a base64url cursor string back to a messageSeq number.
 * Throws CursorError (code: INVALID_REQUEST) if the cursor is malformed or encodes a non-positive integer.
 * @see #74706
 */
export function decodeCursor(cursor: string): number {
  let decoded: number;
  try {
    decoded = Number.parseInt(Buffer.from(cursor, "base64url").toString(), 10);
  } catch {
    throw new CursorError();
  }
  if (!Number.isInteger(decoded) || decoded <= 0) {
    throw new CursorError();
  }
  return decoded;
}
