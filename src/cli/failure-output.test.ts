import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInvalidConfigError } from "../config/io.invalid-config.js";
import { GatewayCredentialsRequiredError, GatewayTransportError } from "../gateway/call.js";
import {
  StateDatabaseMaintenanceScopeError,
  StateDatabaseOfflineMaintenanceError,
} from "../infra/gateway-state-owner-record.js";
import { UpdateSchemaRefusalError } from "../state/openclaw-update-schema-refusal.js";
import {
  ExpectedCliError,
  formatCliFailureLines,
  formatCliJsonFailure,
  toPluginCommandFailure,
} from "./failure-output.js";

function failure(error: unknown, argv?: string[], debug = false) {
  return formatCliFailureLines({
    title: "The CLI command failed.",
    error,
    argv: argv ? ["node", "openclaw", ...argv] : undefined,
    env: debug ? { OPENCLAW_DEBUG: "1" } : {},
  });
}

describe("toPluginCommandFailure", () => {
  beforeEach(() => vi.stubEnv("OPENCLAW_DEBUG", "0"));
  afterEach(() => vi.unstubAllEnvs());

  it("keeps ExitError identity and existing rendering policy", () => {
    const error = Object.assign(new Error("already reported"), { name: "ExitError" });
    expect(toPluginCommandFailure(error)).toBe(error);
  });

  it("keeps debug details except for Commander-coded action failures", () => {
    vi.stubEnv("OPENCLAW_DEBUG", "1");
    const error = new Error("action failed");
    const commanderError = Object.assign(new Error("invalid limit"), {
      name: "InvalidArgumentError",
      code: "commander.invalidArgument",
      exitCode: 1,
    });

    expect(toPluginCommandFailure(error)).toBe(error);
    expect(toPluginCommandFailure(commanderError)).toBeInstanceOf(ExpectedCliError);
  });
});

it.each([false, true])(
  "keeps connection diagnostics out of normal output (sent=%s)",
  (requestDispatched) => {
    const diagnostic = "gateway closed (1006): PRIVATE_CANARY\nConfig: /state/openclaw.json";
    const error = new GatewayTransportError({
      kind: "closed",
      message: diagnostic,
      requestDispatched,
      connectionDetails: {
        url: "ws://127.0.0.1:18789",
        urlSource: "local loopback",
        message: diagnostic,
      },
    });
    const output = failure(error).join("\n");
    expect(output).toContain("openclaw gateway status");
    expect(output).not.toMatch(/PRIVATE_CANARY|\/state\//u);
    expect(output.includes("may have completed")).toBe(requestDispatched);
    expect(formatCliJsonFailure(error, { env: {} }).error.message).toBe(diagnostic);
    expect(failure(error, undefined, true).join("\n")).toBe(diagnostic);
  },
);

it("preserves the typed schema refusal when a runner migration fails before Doctor starts", () => {
  const databases = [
    {
      kind: "state" as const,
      path: "/state/openclaw.sqlite",
      foundVersion: 15,
      supportedVersion: 16,
    },
  ];
  const error = new UpdateSchemaRefusalError(databases, "2026.9.2", {
    targetVersion: "2026.9.4",
    cause: new Error("content migration failed"),
  });
  const output = failure(error, ["update", "--json"]).join("\n");
  expect(output).toContain("[openclaw] OpenClaw needs a manual recovery step.");
  expect(output).toContain("Let the updater restore the previous package and exit");
  expect(output).toContain("openclaw doctor --fix");
  expect(formatCliJsonFailure(error, { env: {} })).toMatchObject({
    ok: false,
    error: {
      type: "cli_error",
      code: "update-schema-bump-unfenced",
      updaterVersion: "2026.9.2",
      message: expect.stringContaining("Deferral failed: content migration failed"),
      databases,
      commands: expect.arrayContaining(["openclaw gateway stop", "openclaw doctor --fix"]),
    },
  });
});

it("uses the canonical typed envelope and redacts the message", () => {
  const token = "sk-abcdefghijklmnopqrstuv";
  const payload = formatCliJsonFailure(new Error(`Authorization: Bearer ${token}`));

  expect(payload).toEqual({
    ok: false,
    error: {
      type: "cli_error",
      message: expect.stringContaining("Authorization: Bearer"),
    },
  });
  expect(payload.error.message).not.toContain(token);
});
it("keeps nested causes behind the debug gate", () => {
  const error = new Error("Promotion is not available.", {
    cause: new Error("ClawHub /api/v1/promotions/nope failed (404)"),
  });

  expect(formatCliJsonFailure(error, { env: {} }).error.message).toBe(
    "Promotion is not available.",
  );
  expect(formatCliJsonFailure(error, { env: { OPENCLAW_DEBUG: "1" } }).error.message).toBe(
    "Promotion is not available. | ClawHub /api/v1/promotions/nope failed (404)",
  );
});

const maintenanceReason =
  "OpenClaw state at ~/.openclaw/state/openclaw.sqlite is undergoing offline maintenance; retry when it finishes.";

it.each([
  ["gateway"],
  ["gateway", "run"],
  ["gateway", "--port", "18789"],
  ["gateway", "run", "--bind", "loopback", "--port", "18789"],
  ["--profile", "work", "gateway", "run"],
  ["node", "run", "--host", "127.0.0.1", "--port", "18789", "--no-tls"],
  ["--profile", "work", "node", "run", "--pair-if-needed", "setup-code"],
])("prints the redacted service startup reason without debug: %j", (...args) => {
  const token = "sk-abcdefghijklmnopqrstuv";
  const lines = failure(
    new Error(`Gateway startup failed. Authorization: Bearer ${token}`, {
      cause: new Error("private nested diagnostic"),
    }),
    [...args],
  );
  const output = lines.join("\n");

  expect(output).toContain("[openclaw] Reason: Gateway startup failed.");
  expect(output).not.toContain(token);
  expect(output).not.toContain("private nested diagnostic");
  expect(lines).not.toContain("[openclaw] Stack:");
});

it.each([
  ["gateway", "status"],
  ["node", "status"],
  ["sessions", "list"],
])("keeps ordinary command failures terse: %j", (...args) => {
  expect(failure(new Error("internal detail"), [...args])).toEqual([
    "[openclaw] The CLI command failed.",
    "[openclaw] For help, run `openclaw doctor`.",
  ]);
});

it("prints the actionable offline maintenance refusal without debug", () => {
  const error = Object.assign(
    new StateDatabaseOfflineMaintenanceError(
      "/tmp/openclaw.sqlite",
      `${maintenanceReason} Authorization: Bearer sk-abcdefghijklmnopqrstuv`,
    ),
    { cause: new Error("private nested diagnostic") },
  );
  const lines = failure(error, ["plugins", "disable", "github"]);
  const output = lines.join("\n");

  expect(output).toContain(`[openclaw] Reason: ${maintenanceReason}`);
  expect(lines).toHaveLength(2);
  expect(output).not.toMatch(
    /sk-abcdefghijklmnopqrstuv|private nested diagnostic|private sibling diagnostic|Stack:|openclaw doctor/u,
  );
});

it("prints the actionable missing-maintenance-scope refusal without debug", () => {
  const error = Object.assign(new StateDatabaseMaintenanceScopeError("/fixture/state.sqlite"), {
    cause: new Error("private nested diagnostic"),
  });

  expect(failure(error, ["plugins", "enable", "github"])).toEqual([
    "[openclaw] The CLI command failed.",
    "[openclaw] Reason: Internal state ownership error at /fixture/state.sqlite: this process holds maintenance ownership without an active schema lease or maintenance scope. Retry the command; if it persists, report this error.",
  ]);
});

it("emits expected guidance only when not already written even with debug output", () => {
  const options = {
    message: "bad input",
    humanOutput: "\u001B[31mfirst\u001B[39m\nsecond\n",
    machineOutput: "first\nsecond\n",
  };
  const pending = new ExpectedCliError(options);
  const written = new ExpectedCliError({
    ...options,
    humanOutputWritten: true,
  });

  expect(failure(pending, undefined, true)).toEqual(["\u001B[31mfirst\u001B[39m", "second"]);
  expect(failure(written, undefined, true)).toEqual([]);
});

it("preserves config validation details when diagnostics have not been emitted", () => {
  const error = Object.assign(
    createInvalidConfigError("/custom/openclaw.json", "- gateway.port: Expected a number"),
    { diagnosticEmitted: false, cause: new Error("internal config loader detail") },
  );

  expect(failure(error, [])).toEqual([
    "[openclaw] The CLI command failed.",
    "[openclaw] Reason: Invalid config at /custom/openclaw.json:\n- gateway.port: Expected a number",
    "[openclaw] For help, run `openclaw doctor`.",
  ]);
});

it("routes missing gateway credentials through the expected-condition predicate without crash framing", () => {
  const error = new GatewayCredentialsRequiredError({
    method: "device.pair.list",
    configPath: "/tmp/openclaw.json",
  });

  const lines = failure(error, undefined, true);

  expect(lines).toEqual(error.message.split("\n"));
  const output = lines.join("\n");
  expect(output).not.toMatch(
    /\[openclaw\] (?:The CLI command failed\.|Reason:)|OPENCLAW_DEBUG|Stack:|openclaw doctor/u,
  );
});

it.each([false, true])(
  "gates root stack details across the child terminator (child=%s)",
  (child) => {
    const error = child
      ? new Error("boom")
      : new Error("boom", { cause: new Error("transport detail") });
    const lines = failure(error, ["proxy", "run", ...(child ? ["--", "child"] : []), "--verbose"]);
    if (child) {
      expect(lines).not.toContain("[openclaw] Stack:");
      expect(lines).toContain("[openclaw] For help, run `openclaw doctor`.");
    } else {
      expect(lines).toContain("[openclaw] Reason: boom | transport detail");
      expect(lines).toContain("[openclaw] Stack:");
      expect(lines).toContain("[openclaw] Error: boom");
    }
  },
);
