export type ReplayControlErrorCode =
  | "replay_disabled"
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "limit_exceeded"
  | "tool_not_recorded"
  | "internal_error";

export class ReplayControlError extends Error {
  readonly code: ReplayControlErrorCode;
  readonly status: number;

  constructor(params: { code: ReplayControlErrorCode; message: string; status: number }) {
    super(params.message);
    this.name = "ReplayControlError";
    this.code = params.code;
    this.status = params.status;
  }
}

export function toHttpErrorResponse(err: unknown): {
  status: number;
  body: { ok: false; error: { code: string; message: string } };
} {
  if (err instanceof ReplayControlError) {
    return {
      status: err.status,
      body: {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
        },
      },
    };
  }
  const message = err instanceof Error && err.message ? err.message : "Internal Server Error";
  return {
    status: 500,
    body: {
      ok: false,
      error: {
        code: "internal_error",
        message,
      },
    },
  };
}
