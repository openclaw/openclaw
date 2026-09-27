import { expect, it } from "vitest";
import { StateDatabaseCoordinatorContentionError } from "../infra/state-database-coordinator-errors.js";
import { formatCliFailureLines, formatCliJsonFailure } from "./failure-output.js";

it.each(["direct", "wrapped", "aggregate", "message-only"])(
  "preserves %s contention output and classifies the Doctor hint by error identity",
  (kind) => {
    const cause = new StateDatabaseCoordinatorContentionError("state-lifecycle");
    const error =
      kind === "direct"
        ? cause
        : kind === "wrapped"
          ? new Error(`Task registry restore failed: ${cause.message}`, { cause })
          : kind === "aggregate"
            ? new AggregateError([cause], cause.message)
            : new Error(cause.message);
    expect(formatCliJsonFailure(error, { env: {} })).toEqual({
      ok: false,
      error: { type: "cli_error", message: error.message },
    });
    expect(formatCliFailureLines({ title: "The CLI command failed.", error, env: {} })).toEqual([
      "[openclaw] The CLI command failed.",
      `[openclaw] Reason: ${error.message}`,
      "[openclaw] Debug: set OPENCLAW_DEBUG=1 to include the stack trace.",
      ...(kind === "message-only" ? ["[openclaw] Try: openclaw doctor"] : []),
      "[openclaw] Help: openclaw --help",
    ]);
    expect(error.message).toContain("Wait for the other OpenClaw process to finish, then retry.");
  },
);
