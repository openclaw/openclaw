import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";

const callGatewayFromCli = vi.hoisted(() => vi.fn());

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return { ...actual, callGatewayFromCli };
});

const { registerCronAddCommand } = await import("./register.cron-add.js");
const { registerCronEditCommand } = await import("./register.cron-edit.js");

async function run(args: readonly string[]) {
  const program = new Command().exitOverride();
  registerCronAddCommand(program);
  registerCronEditCommand(program);
  await program.parseAsync([...args], { from: "user" });
}

function expectRequest(method: string, payload: unknown) {
  expect(callGatewayFromCli).toHaveBeenCalledWith(method, expect.anything(), payload);
}

beforeEach(() => {
  callGatewayFromCli.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("cron precheck CLI", () => {
  it("sends a precheck on add", async () => {
    await run([
      "add",
      "--name",
      "Inbox poll",
      "--every",
      "15m",
      "--precheck",
      "inbox-has-mail",
      "--precheck-timeout-seconds",
      "20",
      "--message",
      "Process new mail",
      "--session",
      "isolated",
    ]);

    expectRequest(
      "cron.add",
      expect.objectContaining({
        precheck: { command: "inbox-has-mail", timeoutSeconds: 20 },
      }),
    );
  });

  it("rejects a blank precheck before calling the gateway", async () => {
    await expect(
      run([
        "add",
        "--name",
        "Inbox poll",
        "--every",
        "15m",
        "--precheck",
        "   ",
        "--message",
        "Process new mail",
        "--session",
        "isolated",
      ]),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("--precheck must not be blank"),
    );
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("clears a precheck and updates only its timeout", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) =>
      method === "cron.get"
        ? {
            id: "job-1",
            precheck: {
              command: "inbox-has-mail",
              timeoutSeconds: 30,
              workExitCodes: [0],
              noWorkExitCodes: [2],
            },
          }
        : { ok: true },
    );

    await run(["edit", "job-1", "--clear-precheck"]);
    expectRequest("cron.update", { id: "job-1", patch: { precheck: null } });

    callGatewayFromCli.mockClear();
    await run(["edit", "job-1", "--precheck-timeout-seconds", "45"]);
    expectRequest("cron.update", {
      id: "job-1",
      patch: {
        precheck: {
          command: "inbox-has-mail",
          timeoutSeconds: 45,
          workExitCodes: [0],
          noWorkExitCodes: [2],
        },
      },
    });
  });
});
