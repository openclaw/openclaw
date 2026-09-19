import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { ExpectedCliError, formatCliJsonFailure } from "../failure-output.js";

const callGatewayFromCli = vi.fn();

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

const { registerCronAddCommand } = await import("./register.cron-add.js");
const { registerCronEditCommand } = await import("./register.cron-edit.js");

function createMutationProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCronAddCommand(program);
  registerCronEditCommand(program);
  return program;
}

const topicMutationCases = [
  {
    operation: "add",
    method: "cron.add",
    args: [
      "add",
      "--name",
      "topic-proof",
      "--every",
      "1m",
      "--agent",
      "main",
      "--message",
      "hello",
      "--channel",
      "telegram",
      "--to",
      "group-123",
    ],
  },
  {
    operation: "edit",
    method: "cron.update",
    args: ["edit", "job-1", "--channel", "telegram", "--to", "group-123"],
  },
] as const;

const creationCwdCases = [
  { flag: "--command-cwd", args: ["--every", "1m", "--command", "pwd"], target: "payload" },
  { flag: "--on-exit-cwd", args: ["--on-exit", "pwd", "--message", "run"], target: "schedule" },
  {
    flag: "--stream-cwd",
    args: ["--stream-command", '["node","events.mjs"]', "--message", "run"],
    target: "schedule",
  },
] as const;

describe("shared automation mutation options", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockResolvedValue({ ok: true });
  });

  it.each(
    creationCwdCases.flatMap((entry) =>
      ["add", "create"].flatMap((operation) =>
        [
          { label: "omitted", value: undefined, expected: undefined, rejects: false },
          { label: "empty", value: "", expected: undefined, rejects: true },
          { label: "whitespace", value: "   ", expected: undefined, rejects: true },
          { label: "valid", value: " /repo ", expected: "/repo", rejects: false },
        ].map(({ label, value, expected, rejects }) => ({
          flag: entry.flag,
          args: entry.args,
          target: entry.target,
          operation,
          label,
          value,
          expected,
          rejects,
        })),
      ),
    ),
  )(
    "handles $label $flag on $operation before RPC",
    async ({ flag, args, target, operation, value, expected, rejects }) => {
      const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      try {
        const run = createMutationProgram().parseAsync(
          [
            operation,
            "--name",
            "cwd-proof",
            "--agent",
            "main",
            ...args,
            ...(value === undefined ? [] : [flag, value]),
          ],
          { from: "user" },
        );
        if (rejects) {
          await expect(run).rejects.toMatchObject({ name: "ExitError", code: 1 });
          expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining(`${flag} must not be blank`),
          );
          expect(callGatewayFromCli).not.toHaveBeenCalled();
        } else {
          await run;
          const creation = callGatewayFromCli.mock.calls.find(([method]) => method === "cron.add");
          expect(creation?.[2]).toHaveProperty(target);
          expect(creation?.[2]?.[target]?.cwd).toBe(expected);
          expect(errorSpy).not.toHaveBeenCalled();
        }
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it.each(creationCwdCases)(
    "preserves the JSON validation error for blank $flag",
    async ({ flag, args }) => {
      const argv = process.argv;
      const input = [
        "create",
        "--name",
        "cwd-json",
        "--agent",
        "main",
        ...args,
        flag,
        "",
        "--json",
      ];
      process.argv = [...argv.slice(0, 2), "automations", ...input];
      try {
        let failure: unknown;
        try {
          await createMutationProgram().parseAsync(input, { from: "user" });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(ExpectedCliError);
        expect(formatCliJsonFailure(failure)).toEqual({
          ok: false,
          error: { type: "cli_error", message: `${flag} must not be blank` },
        });
        expect(callGatewayFromCli).not.toHaveBeenCalled();
      } finally {
        process.argv = argv;
      }
    },
  );

  it.each(["add", "create"])(
    "rejects blank command cwd with a positional schedule on %s",
    async (operation) => {
      const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      try {
        await expect(
          createMutationProgram().parseAsync(
            [
              operation,
              "every 1m",
              "--name",
              "cwd-positional",
              "--agent",
              "main",
              "--command",
              "pwd",
              "--command-cwd",
              "   ",
            ],
            { from: "user" },
          ),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });
        expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("--command-cwd must not be blank"),
        );
        expect(callGatewayFromCli).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it.each([undefined, "", "   "])("preserves stream cwd edit semantics for %j", async (value) => {
    callGatewayFromCli.mockImplementation(async (method: string) =>
      method === "cron.get"
        ? {
            id: "job-1",
            schedule: { kind: "stream", command: ["node", "events.mjs"], cwd: "/repo" },
            payload: { kind: "agentTurn", message: "run" },
          }
        : { ok: true },
    );
    await createMutationProgram().parseAsync(
      [
        "edit",
        "job-1",
        "--stream-mode",
        "line",
        ...(value === undefined ? [] : ["--stream-cwd", value]),
      ],
      { from: "user" },
    );
    const update = callGatewayFromCli.mock.calls.find(([method]) => method === "cron.update");
    expect(update?.[2]).toMatchObject({
      id: "job-1",
      patch: { schedule: { kind: "stream", command: ["node", "events.mjs"] } },
    });
    expect(update?.[2]?.patch?.schedule?.cwd).toBe(value === undefined ? "/repo" : undefined);
  });

  it.each(
    ["--at", "--every", "--cron", "--on-exit"].flatMap((flag) =>
      ["", "   "].map((value) => ({ flag, value })),
    ),
  )("rejects explicit blank $flag=$value on edit before RPC", async ({ flag, value }) => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      await expect(
        createMutationProgram().parseAsync(["edit", "job-1", flag, value], { from: "user" }),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });
      expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("Schedule values must not be blank"),
      );
      expect(callGatewayFromCli).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each(
    ["add", "create"].flatMap((operation) => ["", "   "].map((value) => ({ operation, value }))),
  )("rejects a blank schedule mixed with --every on $operation", async ({ operation, value }) => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      await expect(
        createMutationProgram().parseAsync(
          [
            operation,
            "--name",
            "blank-schedule",
            "--agent",
            "main",
            "--message",
            "hello",
            "--every",
            "1h",
            "--cron",
            value,
          ],
          { from: "user" },
        ),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });
      expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("Schedule values must not be blank"),
      );
      expect(callGatewayFromCli).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects a blank schedule before mutation after a pacing read", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) =>
      method === "cron.get"
        ? {
            id: "job-1",
            configRevision: "fixture-revision-1",
            pacing: { min: "1m", max: "1h" },
          }
        : { ok: true },
    );
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      await expect(
        createMutationProgram().parseAsync(
          ["edit", "job-1", "--pacing-min", "30m", "--every", ""],
          { from: "user" },
        ),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });
      expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("Schedule values must not be blank"),
      );
      expect(callGatewayFromCli).toHaveBeenCalledWith("cron.get", expect.anything(), {
        id: "job-1",
      });
      expect(callGatewayFromCli.mock.calls.map(([method]) => method)).not.toContain("cron.update");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([
    { label: "omitted", args: [], rejects: false },
    { label: "blank", args: ["--every", ""], rejects: true },
  ])("distinguishes an $label schedule from a name-only edit", async ({ args, rejects }) => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      const run = createMutationProgram().parseAsync(
        ["edit", "job-1", "--name", "Renamed", ...args],
        { from: "user" },
      );
      if (rejects) {
        await expect(run).rejects.toMatchObject({ name: "ExitError", code: 1 });
        expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("Schedule values must not be blank"),
        );
        expect(callGatewayFromCli).not.toHaveBeenCalled();
      } else {
        await run;
        expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
          id: "job-1",
          patch: { name: "Renamed" },
        });
        expect(errorSpy).not.toHaveBeenCalled();
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([
    { operation: "add", flag: "--every" },
    { operation: "add", flag: "--stagger" },
    { operation: "edit", flag: "--every" },
    { operation: "edit", flag: "--stagger" },
  ])(
    "rejects out-of-range configured duration precision for $operation $flag before RPC",
    async ({ operation, flag }) => {
      const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const args =
        operation === "add"
          ? [
              "add",
              "--name",
              "Duration boundary",
              "--agent",
              "main",
              "--system-event",
              "test",
              "--disabled",
            ]
          : ["edit", "job-1"];
      try {
        await expect(
          createMutationProgram().parseAsync(
            [
              ...args,
              ...(flag === "--stagger" ? ["--cron", "0 * * * *", "--tz", "UTC"] : []),
              flag,
              "8640000000000001ms",
            ],
            { from: "user" },
          ),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`Invalid ${flag}`));
        expect(callGatewayFromCli).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it.each(["--every", "--stagger"])(
    "accepts the inclusive configured duration precision limit for %s",
    async (flag) => {
      await createMutationProgram().parseAsync(
        [
          "add",
          "--name",
          "Duration boundary",
          "--agent",
          "main",
          "--system-event",
          "test",
          "--disabled",
          ...(flag === "--stagger" ? ["--cron", "0 * * * *"] : []),
          flag,
          "8640000000000000ms",
        ],
        { from: "user" },
      );

      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "cron.add",
        expect.anything(),
        expect.objectContaining({
          enabled: false,
          schedule:
            flag === "--every"
              ? { kind: "every", everyMs: 8_640_000_000_000_000 }
              : {
                  kind: "cron",
                  expr: "0 * * * *",
                  tz: undefined,
                  staggerMs: 8_640_000_000_000_000,
                },
        }),
      );
    },
  );

  it("updates an existing automation to an exit-triggered schedule", async () => {
    await createMutationProgram().parseAsync(
      ["edit", "job-1", "--on-exit", "./watch.sh", "--on-exit-cwd", "/repo"],
      { from: "user" },
    );

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { schedule: { kind: "on-exit", command: "./watch.sh", cwd: "/repo" } },
    });
  });

  it.each([
    [["--on-exit-cwd", "/repo"], "--on-exit-cwd requires --on-exit"],
    [["--on-exit", "./watch.sh", "--every", "5m"], "Choose at most one schedule change"],
  ])("rejects invalid exit-triggered schedule options", async (args, message) => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      await expect(
        createMutationProgram().parseAsync(["edit", "job-1", ...args], { from: "user" }),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(message));
      expect(callGatewayFromCli).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each(
    topicMutationCases.flatMap((mutation) =>
      ["", "   "].map((threadId) => ({
        operation: mutation.operation,
        args: mutation.args,
        threadId,
      })),
    ),
  )(
    "rejects blank thread id $threadId before automation $operation",
    async ({ args, threadId }) => {
      const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      try {
        await expect(
          createMutationProgram().parseAsync([...args, "--thread-id", threadId], {
            from: "user",
          }),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("--thread-id must be a positive integer"),
        );
        expect(callGatewayFromCli).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it.each(topicMutationCases)(
    "preserves omitted and maximum-safe topic ids on automation $operation",
    async ({ operation, method, args }) => {
      for (const threadId of [undefined, Number.MAX_SAFE_INTEGER]) {
        callGatewayFromCli.mockClear();
        await createMutationProgram().parseAsync(
          [...args, ...(threadId === undefined ? [] : ["--thread-id", String(threadId)])],
          { from: "user" },
        );
        const call = callGatewayFromCli.mock.calls.find(
          ([calledMethod]) => calledMethod === method,
        );
        const request = call?.[2] as {
          delivery?: { threadId?: number };
          patch?: { delivery?: { threadId?: number } };
        };
        const delivery = operation === "add" ? request.delivery : request.patch?.delivery;
        expect(delivery?.threadId).toBe(threadId);
      }
    },
  );

  it.each(["", "   ", "topic-42"])(
    "rejects invalid thread id %j before loading an automation for a combined edit",
    async (threadId) => {
      const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      try {
        await expect(
          createMutationProgram().parseAsync(
            [
              "edit",
              "job-1",
              "--pacing-min",
              "30m",
              "--channel",
              "telegram",
              "--to",
              "group-123",
              "--thread-id",
              threadId,
            ],
            { from: "user" },
          ),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("--thread-id must be a positive integer"),
        );
        expect(callGatewayFromCli).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it("keeps creation defaults out of automation edit patches", () => {
    const program = createMutationProgram();
    const add = program.commands.find((command) => command.name() === "add")!;
    const edit = program.commands.find((command) => command.name() === "edit")!;
    const creationDefaults: Array<[string, string | boolean]> = [
      ["wake", "now"],
      ["tz", ""],
      ["exact", false],
      ["lightContext", false],
      ["announce", false],
      ["channel", "last"],
      ["bestEffortDeliver", false],
    ];

    for (const [name, value] of creationDefaults) {
      expect(add.getOptionValue(name)).toBe(value);
      expect(edit.getOptionValue(name)).toBeUndefined();
    }
  });
});
