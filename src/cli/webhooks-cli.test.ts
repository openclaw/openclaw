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

async function expectFailure(run: Promise<unknown>, json: boolean, message: string) {
  await expect(run).rejects.toThrow(json ? message : "__exit__:1");
  expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
  expect(mocks.runtimeErrors).toEqual(json ? [] : [expect.stringContaining(message)]);
  expect(mocks.defaultRuntime.exit).toHaveBeenCalledTimes(json ? 0 : 1);
}

describe("webhooks cli", () => {
  const tailscaleError = "Invalid --tailscale (must be funnel, serve, or off).";
  beforeEach(() => {
    mocks.runtimeLogs.length = 0;
    mocks.runtimeErrors.length = 0;
    vi.clearAllMocks();
  });

  it.each([
    ["setup", "--port", "8080x", "--port must be a positive integer.", true],
    ["setup", "--account", " ", "--account is required.", true],
    ["setup", "--tailscale", "invalid", tailscaleError, true],
    ["setup", "--max-bytes", "10mb", "--max-bytes must be a positive integer.", true],
    ["setup", "--renew-minutes", "30m", "--renew-minutes must be a positive integer.", true],
    ["run", "--max-bytes", "10mb", "--max-bytes must be a positive integer."],
    ["run", "--renew-minutes", "30m", "--renew-minutes must be a positive integer."],
    ["setup", "--tailscale", "", tailscaleError],
    ["run", "--tailscale", "offf", tailscaleError],
  ])("rejects invalid gmail %s %s=%j", async (command, flag, value, message, json = false) => {
    const args = [flag, value, ...(json ? ["--json"] : [])];
    if (command === "setup") {
      await expect(parse(command, args)).rejects.toMatchObject({
        name: "ExpectedCliError",
        humanOutput: expect.stringContaining(message),
        machineOutput: expect.stringContaining(message),
      });
    } else {
      await expectFailure(parse(command, args), json, message);
    }
    expect(mocks.runGmailSetup).not.toHaveBeenCalled();
    expect(mocks.runGmailService).not.toHaveBeenCalled();
  });

  it.each([
    { command: "setup", mode: "human", json: false },
    { command: "setup", mode: "JSON", json: true },
    { command: "setup", mode: "expected JSON", json: true, name: "LocalStateOwnerError" },
    { command: "run", mode: "human", json: false },
  ])("redacts $command failures in $mode mode", async ({ command, json, name }) => {
    const secret = "sk-abcdefghijklmnopqrstuv";
    const error = new Error(`Gmail failed: Authorization: Bearer ${secret}`);
    error.name = name ?? "GmailCredentialError";
    const runner = command === "setup" ? mocks.runGmailSetup : mocks.runGmailService;
    runner.mockRejectedValueOnce(error);
    const args = json ? ["--json"] : [];
    const run = parse(command, args);
    await expectFailure(run, json, "Gmail failed: Authorization: Bearer");
    await expect(run).rejects.not.toThrow(secret);
    const output = [...mocks.runtimeLogs, ...mocks.runtimeErrors].join("\n");
    for (const privateValue of [error.name, secret]) {
      expect(output).not.toContain(privateValue);
    }
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
    ["run", ["--tailscale", "off"], { tailscale: "off" }],
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
