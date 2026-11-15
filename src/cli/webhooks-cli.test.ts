import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerWebhooksCli } from "./webhooks-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return {
    ...createCliRuntimeMock(vi),
    runGmailSetup: vi.fn(),
    runGmailService: vi.fn(),
  };
});

vi.mock("../hooks/gmail-ops.js", () => ({
  runGmailSetup: mocks.runGmailSetup,
  runGmailService: mocks.runGmailService,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

function parse(command: string, args: string[] = []) {
  const program = new Command().exitOverride();
  registerWebhooksCli(program);
  const defaults =
    command === "setup" && !args.includes("--account") ? ["--account", "default"] : [];
  return program.parseAsync(["webhooks", "gmail", command, ...defaults, ...args], { from: "user" });
}

function runtimeErrors(): string[] {
  return mocks.defaultRuntime.error.mock.calls.map(([message]) => String(message));
}

async function expectFailure(command: string, args: string[], json: boolean, message: string) {
  await expect(parse(command, args)).rejects.toThrow(json ? message : "__exit__:1");
  expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
  if (json) {
    expect(mocks.defaultRuntime.error).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
  } else {
    expect(runtimeErrors()).toEqual([expect.stringContaining(message)]);
  }
}

describe("webhooks cli", () => {
  beforeEach(() => {
    mocks.runtimeLogs.length = 0;
    mocks.runtimeErrors.length = 0;
    vi.clearAllMocks();
  });

  it.each([
    ["setup", "--port", "8080x", "--port must be a positive integer.", true],
    ["run", "--max-bytes", "10mb", "--max-bytes must be a positive integer."],
    ["run", "--renew-minutes", "30m", "--renew-minutes must be a positive integer."],
    ["setup", "--tailscale", "", "Invalid --tailscale (must be funnel, serve, or off)."],
    ["run", "--tailscale", "offf", "Invalid --tailscale (must be funnel, serve, or off)."],
  ])("rejects invalid gmail %s %s=%j", async (command, flag, value, message, json = false) => {
    const args = [flag, value, ...(json ? ["--json"] : [])];
    await expectFailure(command, args, json, message);
    for (const runner of [mocks.runGmailSetup, mocks.runGmailService]) {
      expect(runner).not.toHaveBeenCalled();
    }
  });

  it.each([
    { command: "setup", mode: "human", json: false },
    { command: "setup", mode: "JSON", json: true },
    { command: "run", mode: "human", json: false },
  ])("renders named gmail $command errors safely in $mode mode", async ({ command, json }) => {
    const secret = "sk-abcdefghijklmnopqrstuv";
    const error = new Error(`Gmail failed: Authorization: Bearer ${secret}`);
    error.name = "GmailCredentialError";
    const runner = command === "setup" ? mocks.runGmailSetup : mocks.runGmailService;
    runner.mockRejectedValueOnce(error);
    const args = json ? ["--json"] : [];
    await expectFailure(command, args, json, "Gmail failed: Authorization: Bearer");
    const output = [...mocks.runtimeLogs, ...runtimeErrors()].join("\n");
    for (const privateValue of [error.name, secret]) {
      expect(output).not.toContain(privateValue);
    }
  });

  it("accepts an explicitly disabled Gmail exposure mode", async () => {
    await parse("run", ["--tailscale", "off"]);

    expect(mocks.runGmailService).toHaveBeenCalledWith(
      expect.objectContaining({ tailscale: "off" }),
    );
  });

  it.each([
    [
      "setup",
      ["--account", "fixture@example.invalid"],
      {
        account: "fixture@example.invalid",
        topic: "gog-gmail-watch",
        subscription: "gog-gmail-watch-push",
        label: "INBOX",
        bind: "127.0.0.1",
        port: 8788,
        path: "/gmail-pubsub",
        includeBody: true,
        maxBytes: 20_000,
        renewEveryMinutes: 720,
        tailscale: "funnel",
        json: false,
      },
    ],
    [
      "run",
      [],
      { account: undefined, port: undefined, includeBody: undefined, tailscale: undefined },
    ],
    [
      "setup",
      [
        "--account",
        " fixture@example.invalid ",
        "--project",
        " fixture-project ",
        "--push-endpoint",
        " https://fixture.invalid/push ",
        "--hook-token",
        " fixture-token ",
        "--port",
        "9807",
        "--include-body",
        "--tailscale",
        " serve ",
        "--json",
      ],
      {
        account: "fixture@example.invalid",
        project: "fixture-project",
        pushEndpoint: "https://fixture.invalid/push",
        hookToken: "fixture-token",
        port: 9807,
        includeBody: true,
        tailscale: "serve",
        json: true,
      },
    ],
  ] satisfies [string, string[], Record<string, unknown>][])(
    "applies %s defaults or explicit string, integer and boolean options",
    async (command, args, expected) => {
      await parse(command, args);
      const runner = command === "setup" ? mocks.runGmailSetup : mocks.runGmailService;
      expect(runner.mock.calls[0]?.[0]).toMatchObject(expected);
    },
  );
});
