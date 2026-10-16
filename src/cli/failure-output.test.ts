// Failure output tests cover CLI error formatting and failure summaries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInvalidConfigError } from "../config/io.invalid-config.js";
import { GatewayCredentialsRequiredError, GatewayTransportError } from "../gateway/call.js";
import { StateDatabaseOfflineMaintenanceError } from "../infra/gateway-state-owner-record.js";
import { UpdateSchemaRefusalError } from "../state/openclaw-update-schema-refusal.js";
import {
  ExpectedCliError,
  formatCliFailureLines,
  formatCliJsonFailure,
  isExpectedCliError,
  toPluginCommandFailure,
} from "./failure-output.js";

describe("toPluginCommandFailure", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_DEBUG", "0");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([Object.assign(new Error("already reported"), { name: "ExitError" })])(
    "keeps $name identity and existing rendering policy",
    (error) => {
      expect(toPluginCommandFailure(error)).toBe(error);
    },
  );

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

describe("formatCliJsonFailure", () => {
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
      const output = formatCliFailureLines({ title: "Command failed", error, env: {} }).join("\n");
      expect(output).toContain("openclaw gateway status");
      expect(output).not.toContain("PRIVATE_CANARY");
      expect(output).not.toContain("/state/");
      expect(output.includes("may have completed")).toBe(requestDispatched);
      expect(formatCliJsonFailure(error, { env: {} }).error.message).toBe(diagnostic);
      expect(
        formatCliFailureLines({
          title: "Command failed",
          error,
          env: { OPENCLAW_DEBUG: "1" },
        }).join("\n"),
      ).toBe(diagnostic);
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
    const output = formatCliFailureLines({
      title: "Update failed",
      error,
      argv: ["node", "openclaw", "update", "--json"],
      env: {},
    }).join("\n");
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
});

describe("formatCliFailureLines", () => {
  const maintenanceReason =
    "OpenClaw state at ~/.openclaw/state/openclaw.sqlite is undergoing offline maintenance; retry when it finishes.";

  it.each([
    ["gateway"],
    ["gateway", "run"],
    ["gateway", "--port", "18789"],
    ["gateway", "run", "--bind", "loopback", "--port", "18789"],
    ["--profile", "work", "gateway", "run"],
  ])("prints the redacted Gateway startup reason without debug: %j", (...args) => {
    const token = "sk-abcdefghijklmnopqrstuv";
    const lines = formatCliFailureLines({
      title: "The CLI command failed.",
      error: new Error(`Gateway startup failed. Authorization: Bearer ${token}`, {
        cause: new Error("private nested diagnostic"),
      }),
      argv: ["node", "openclaw", ...args],
      env: {},
    });
    const output = lines.join("\n");

    expect(output).toContain("[openclaw] Reason: Gateway startup failed.");
    expect(output).not.toContain(token);
    expect(output).not.toContain("private nested diagnostic");
    expect(lines).not.toContain("[openclaw] Stack:");
  });

  it.each([
    ["gateway", "status"],
    ["sessions", "list"],
  ])("keeps ordinary command failures terse: %j", (...args) => {
    expect(
      formatCliFailureLines({
        title: "The CLI command failed.",
        error: new Error("internal detail"),
        argv: ["node", "openclaw", ...args],
        env: {},
      }),
    ).toEqual([
      "[openclaw] The CLI command failed.",
      "[openclaw] For help, run `openclaw doctor`.",
    ]);
  });

  it.each([
    [
      "offline maintenance refusal",
      Object.assign(
        new StateDatabaseOfflineMaintenanceError(
          "/tmp/openclaw.sqlite",
          `${maintenanceReason} Authorization: Bearer sk-abcdefghijklmnopqrstuv`,
        ),
        { cause: new Error("private nested diagnostic") },
      ),
      maintenanceReason,
      ["plugins", "disable", "github"],
    ],
  ])("prints the actionable state refusal without debug: %s", (_label, error, reason, args) => {
    const lines = formatCliFailureLines({
      title: "The CLI command failed.",
      error,
      argv: ["node", "openclaw", ...args],
      env: {},
    });
    const output = lines.join("\n");

    expect(output).toContain(`[openclaw] Reason: ${reason}`);
    expect(lines).toHaveLength(2);
    expect(output).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(output).not.toContain("private nested diagnostic");
    expect(output).not.toContain("private sibling diagnostic");
    expect(output).not.toContain("Stack:");
    expect(output).not.toContain("openclaw doctor");
  });

  it("emits expected guidance only when not already written even with debug output", () => {
    const env = { OPENCLAW_DEBUG: "1" };
    const pending = new ExpectedCliError({
      message: "bad input",
      humanOutput: "\u001B[31mfirst\u001B[39m\nsecond\n",
      machineOutput: "first\nsecond\n",
    });
    const written = new ExpectedCliError({
      message: "bad input",
      humanOutput: "\u001B[31mfirst\u001B[39m\nsecond\n",
      humanOutputWritten: true,
      machineOutput: "first\nsecond\n",
    });

    expect(formatCliFailureLines({ title: "ignored", error: pending, env })).toEqual([
      "\u001B[31mfirst\u001B[39m",
      "second",
    ]);
    expect(formatCliFailureLines({ title: "ignored", error: written, env })).toEqual([]);
  });

  it("preserves config validation details when diagnostics have not been emitted", () => {
    const error = Object.assign(
      createInvalidConfigError("/custom/openclaw.json", "- gateway.port: Expected a number"),
      { diagnosticEmitted: false, cause: new Error("internal config loader detail") },
    );

    expect(
      formatCliFailureLines({ title: "The CLI command failed.", error, argv: [], env: {} }),
    ).toEqual([
      "[openclaw] The CLI command failed.",
      "[openclaw] Reason: Invalid config at /custom/openclaw.json:\n- gateway.port: Expected a number",
      "[openclaw] For help, run `openclaw doctor`.",
    ]);
  });

  it.each([
    {
      label: "missing gateway credentials",
      createError: () =>
        new GatewayCredentialsRequiredError({
          method: "device.pair.list",
          configPath: "/tmp/openclaw.json",
        }),
    },
  ])(
    "routes $label through the shared expected-condition predicate without crash framing",
    ({ createError }) => {
      const error = createError();

      expect(isExpectedCliError(error)).toBe(true);
      const lines = formatCliFailureLines({
        title: "The CLI command failed.",
        error,
        env: { OPENCLAW_DEBUG: "1" },
      });

      expect(lines).toEqual(error.message.split("\n"));
      const output = lines.join("\n");
      expect(output).not.toContain("[openclaw] The CLI command failed.");
      expect(output).not.toContain("[openclaw] Reason:");
      expect(output).not.toContain("OPENCLAW_DEBUG");
      expect(output).not.toContain("Stack:");
      expect(output).not.toContain("openclaw doctor");
    },
  );

  it.each(["--verbose"])("prints stack details for the root %s option", (debugFlag) => {
    const lines = formatCliFailureLines({
      title: "The CLI command failed.",
      error: new Error("boom", { cause: new Error("transport detail") }),
      argv: ["node", "openclaw", "proxy", "run", debugFlag],
      env: {},
    });

    expect(lines).toContain("[openclaw] Reason: boom | transport detail");
    expect(lines).toContain("[openclaw] Stack:");
    expect(lines).toContain("[openclaw] Error: boom");
  });

  it.each(["--verbose"])("does not enable root stack traces for a child %s option", (debugFlag) => {
    const lines = formatCliFailureLines({
      title: "The CLI command failed.",
      error: new Error("boom"),
      argv: ["node", "openclaw", "proxy", "run", "--", "child", debugFlag],
      env: {},
    });

    expect(lines).not.toContain("[openclaw] Stack:");
    expect(lines).toContain("[openclaw] For help, run `openclaw doctor`.");
  });
});
