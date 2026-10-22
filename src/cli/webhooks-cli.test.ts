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

function expectNoRuntimeOutput() {
  for (const method of ["writeJson", "error", "exit"] as const) {
    expect(mocks.defaultRuntime[method]).not.toHaveBeenCalled();
  }
}

function expectNoGmailCalls() {
  expect(mocks.runGmailSetup).not.toHaveBeenCalled();
  expect(mocks.runGmailService).not.toHaveBeenCalled();
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
    if (json) {
      await expect(parse(command, args)).rejects.toThrow(message);
      expectNoRuntimeOutput();
    } else {
      await expect(parse(command, args)).rejects.toThrow("__exit__:1");
      expect(runtimeErrors().join("\n")).toContain(message);
    }
    expectNoGmailCalls();
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
    if (json) {
      await expect(parse(command, args)).rejects.toThrow("Gmail failed: Authorization: Bearer");
      expectNoRuntimeOutput();
    } else {
      await expect(parse(command, args)).rejects.toThrow("__exit__:1");
      expect(runtimeErrors()).toEqual([
        expect.stringContaining("Gmail failed: Authorization: Bearer"),
      ]);
      expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
      expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
    }
    expect(runner).toHaveBeenCalledOnce();
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

  // Inputs and expected normalized values are independent; defaults/omissions share only keys.
  const commonOptions: [string, string, string | undefined, string | number | boolean][] = [
    ["--topic", "topic", " projects/fixture/topics/custom ", "projects/fixture/topics/custom"],
    ["--subscription", "subscription", " custom-subscription ", "custom-subscription"],
    ["--label", "label", " CUSTOM ", "CUSTOM"],
    ["--hook-url", "hookUrl", " https://hook.invalid/gmail ", "https://hook.invalid/gmail"],
    ["--hook-token", "hookToken", " fixture-hook ", "fixture-hook"],
    ["--push-token", "pushToken", " fixture-push ", "fixture-push"],
    ["--bind", "bind", " 127.0.0.2 ", "127.0.0.2"],
    ["--port", "port", "9807", 9807],
    ["--path", "path", " /custom-push ", "/custom-push"],
    ["--include-body", "includeBody", undefined, true],
    ["--max-bytes", "maxBytes", "54321", 54321],
    ["--renew-minutes", "renewEveryMinutes", "29", 29],
    ["--tailscale", "tailscale", " serve ", "serve"],
    ["--tailscale-path", "tailscalePath", " /public-gmail ", "/public-gmail"],
    ["--tailscale-target", "tailscaleTarget", " http://127.0.0.3:8789 ", "http://127.0.0.3:8789"],
  ];
  const explicitCommonArgs = commonOptions.flatMap(([flag, , value]) =>
    value === undefined ? [flag] : [flag, value],
  );
  const explicitCommonOptions = Object.fromEntries(
    commonOptions.map(([, key, , value]) => [key, value]),
  );
  const omittedCommonOptions = Object.fromEntries(commonOptions.map(([, key]) => [key, undefined]));

  it.each([
    [
      "setup",
      ["--account", "fixture@example.invalid"],
      {
        ...omittedCommonOptions,
        account: "fixture@example.invalid",
        project: undefined,
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
        pushEndpoint: undefined,
        json: false,
      },
    ],
    ["run", [], { account: undefined, ...omittedCommonOptions }],
    [
      "setup",
      [
        "--account",
        " fixture@example.invalid ",
        "--project",
        " fixture-project ",
        "--push-endpoint",
        " https://fixture.invalid/push ",
        "--json",
        ...explicitCommonArgs,
      ],
      {
        account: "fixture@example.invalid",
        project: "fixture-project",
        ...explicitCommonOptions,
        pushEndpoint: "https://fixture.invalid/push",
        json: true,
      },
    ],
    [
      "run",
      ["--account", " fixture@example.invalid ", ...explicitCommonArgs],
      { account: "fixture@example.invalid", ...explicitCommonOptions },
    ],
  ] satisfies [string, string[], Record<string, unknown>][])(
    "passes %s %j to the Gmail command owner",
    async (command, args, expected) => {
      await parse(command, args);

      const runner = command === "setup" ? mocks.runGmailSetup : mocks.runGmailService;
      expect(runner).toHaveBeenCalledOnce();
      expect(runner.mock.calls[0]?.[0]).toStrictEqual(expected);
    },
  );
});
