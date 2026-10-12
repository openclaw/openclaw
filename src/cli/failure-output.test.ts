// Failure output tests cover CLI error formatting and failure summaries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInvalidConfigError } from "../config/io.invalid-config.js";
import {
  GatewayCredentialsRequiredError,
  GatewayExplicitAuthRequiredError,
  GatewayTransportError,
} from "../gateway/call.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
} from "../state/agent-database-admission.js";
import { UpdateSchemaRefusalError } from "../state/openclaw-update-schema-refusal.js";
import {
  ExpectedCliError,
  formatCliFailureLines,
  formatCliJsonFailure,
  isExpectedCliError,
  toPluginCommandFailure,
} from "./failure-output.js";

// Mirrors the producer in ensureExplicitGatewayAuth: the message already carries the remedy.
const EXPLICIT_GATEWAY_AUTH_MESSAGE = [
  "gateway url override requires explicit credentials",
  "Fix: pass --token or --password with --url (or gatewayToken in tools).",
  "For the default local or SSH-tunneled Gateway, remove --url to use the configured target.",
  "Config: /tmp/openclaw.json",
].join("\n");

describe("toPluginCommandFailure", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_DEBUG", "0");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    new Error("--limit must be a positive integer\nUse a value greater than zero."),
    Object.assign(new Error("invalid limit"), {
      name: "InvalidArgumentError",
      code: "commander.invalidArgument",
      exitCode: 1,
    }),
  ])("preserves the operator message and cause for $name", (error) => {
    const failure = toPluginCommandFailure(error);

    expect(failure).toSatisfy(
      (value: unknown) => value instanceof ExpectedCliError && value.cause === error,
    );
    expect(failure).toMatchObject({ message: error.message });
    expect(
      formatCliFailureLines({
        title: "The CLI command failed.",
        error: failure,
        argv: ["node", "openclaw", "x"],
        env: {},
      }),
    ).toEqual(error.message.split("\n"));
    expect(formatCliJsonFailure(failure).error.message).toBe(error.message);
  });

  it.each([
    Object.assign(new Error("already reported"), { name: "CommanderError" }),
    Object.assign(new Error("already reported"), { name: "ExitError" }),
    Object.assign(new Error("state owner guidance"), { name: "LocalStateOwnerError" }),
    new ExpectedCliError({
      message: "expected",
      humanOutput: "expected",
      machineOutput: "expected",
    }),
  ])("keeps $name identity and existing rendering policy", (error) => {
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

  it("keeps the full parse guidance unchanged even with debug output", () => {
    const env = { OPENCLAW_DEBUG: "1" };
    const error = Object.assign(
      new ExpectedCliError({
        message: 'OpenClaw sessions has no command "lst".',
        humanOutput:
          '\u001B[31mOpenClaw sessions has no command "lst".\u001B[39m\nDid you mean this?\n  openclaw sessions list\nTry: openclaw sessions --help\nDocs: \u001B]8;;https://docs.openclaw.ai/cli\u0007docs.openclaw.ai/cli\u001B]8;;\u0007\n',
        machineOutput:
          'OpenClaw sessions has no command "lst".\nDid you mean this?\n  openclaw sessions list\nTry: openclaw sessions --help\nDocs: https://docs.openclaw.ai/cli\n',
      }),
      { cause: new Error("internal parse cause") },
    );
    const payload = formatCliJsonFailure(error, { env });

    expect(payload).toEqual({
      ok: false,
      error: {
        type: "cli_error",
        message:
          'OpenClaw sessions has no command "lst".\nDid you mean this?\n  openclaw sessions list\nTry: openclaw sessions --help\nDocs: https://docs.openclaw.ai/cli',
      },
    });
  });
});

describe("formatCliFailureLines", () => {
  it.each(["single", "aggregated"])(
    "shows %s agent database recovery steps instead of a generic doctor hint",
    (kind) => {
      const refuse = (agentId: string) => {
        const cause = Object.assign(new Error("file is not a database"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 26,
        });
        return new AgentDatabaseAdmissionError(
          createAgentDatabaseInspectionRefusal({
            agentId,
            paths: [`/state/agents/${agentId}/agent/openclaw-agent.sqlite`],
            reason: cause.message,
            cause,
          }),
        );
      };
      const agentIds = kind === "single" ? ["main"] : ["main", "worker"];
      const failures = agentIds.map(refuse);
      const error =
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, failures.map((failure) => failure.message).join("\n"));
      const output = formatCliFailureLines({
        title: "The CLI command failed.",
        error,
        argv: ["node", "openclaw", "gateway", "run"],
        env: {},
      }).join("\n");

      expect(output).toContain("[openclaw] OpenClaw needs a manual recovery step.");
      for (const agentId of agentIds) {
        expect(output).toContain(
          `openclaw doctor --session-sqlite recover --session-sqlite-agent ${agentId}`,
        );
      }
      expect(output).not.toContain("For help, run `openclaw doctor`");
    },
  );

  it.each([
    ["--profile", "work", "update", "--json"],
    ["plugins", "update", "--all"],
    ["--profile", "work", "plugins", "update", "codex"],
    ["--log-level", "debug", "plugins", "update", "codex"],
  ])("keeps update recovery reasons without diagnostic flags: %j", (...args) => {
    const reason =
      "Package convergence must wait until the updating parent releases its install records. Run openclaw update repair.";
    const token = "sk-abcdefghijklmnopqrstuv";
    const output = formatCliFailureLines({
      title: "The CLI command failed.",
      error: new Error(`${reason} Authorization: Bearer ${token}`, {
        cause: new Error("private nested diagnostic"),
      }),
      argv: ["node", "openclaw", ...args],
      env: {},
    }).join("\n");

    expect(output).toContain(reason);
    expect(output).not.toContain(token);
    expect(output).not.toContain("private nested diagnostic");
    expect(output).not.toContain("Stack:");
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
    {
      label: "gateway URL override without explicit credentials",
      createError: () => new GatewayExplicitAuthRequiredError(EXPLICIT_GATEWAY_AUTH_MESSAGE),
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
