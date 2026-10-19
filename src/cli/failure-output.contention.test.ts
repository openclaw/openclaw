import { expect, it } from "vitest";
import { GatewayStateOwnerContentionError } from "../infra/gateway-state-owner.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import { OpenClawDatabaseSchemaPreflightError } from "../state/openclaw-database-preflight.messages.js";
import { formatCliFailureLines, formatCliJsonFailure } from "./failure-output.js";

it.each([
  new DoctorUnreadableStateDatabaseError("/state/openclaw.sqlite", "unreadable"),
  new OpenClawDatabaseSchemaPreflightError([
    { kind: "state", path: "/state/openclaw.sqlite", foundVersion: 20, supportedVersion: 19 },
  ]),
])("preserves the manual recovery when Doctor cannot repair $name", (error) => {
  const output = formatCliFailureLines({ title: "Command failed", error, env: {} }).join("\n");
  expect(output).toContain("restore");
  expect(output).toContain("backup");
  expect(output).not.toContain("For help, run `openclaw doctor`");
});

it.each(["nested", "message-only"])(
  "preserves %s contention output and classifies the Doctor hint by error identity",
  (kind) => {
    const cause = new GatewayStateOwnerContentionError("/synthetic/openclaw.sqlite");
    const error =
      kind === "nested"
        ? new AggregateError(
            [new Error(`Task registry restore failed: ${cause.message}`, { cause })],
            cause.message,
          )
        : new Error(cause.message);
    expect(formatCliJsonFailure(error, { env: {} })).toEqual({
      ok: false,
      error: { type: "cli_error", message: error.message },
    });
    expect(formatCliFailureLines({ title: "The CLI command failed.", error, env: {} })).toEqual([
      "[openclaw] The CLI command failed.",
      kind === "nested"
        ? "[openclaw] Another OpenClaw process is using your data. Wait for it to finish before trying again."
        : "[openclaw] For help, run `openclaw doctor`.",
    ]);
    expect(error.message).toContain("Wait for the other OpenClaw process to finish, then retry.");
  },
);
