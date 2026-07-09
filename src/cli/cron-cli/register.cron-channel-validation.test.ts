// Cron channel-type hint tests: a channel id passed to --channel /
// --failure-alert-channel (which name a channel TYPE) warns at add/edit time,
// without blocking - the Gateway stays authoritative for whether it can route.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";

const hoisted = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
  listChannelPluginsMock: vi.fn(),
}));

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      hoisted.callGatewayFromCli(...args),
  };
});

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: hoisted.listChannelPluginsMock,
}));

const { registerCronAddCommand } = await import("./register.cron-add.js");
const { registerCronEditCommand } = await import("./register.cron-edit.js");

const CHANNEL_WARNING = "is not a recognized channel type";

function createAddProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCronAddCommand(program);
  return program;
}

function createEditProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCronEditCommand(program);
  return program;
}

function expectNoChannelWarning(spy: ReturnType<typeof vi.spyOn>): void {
  const warned = spy.mock.calls.some(
    (call: unknown[]) => typeof call[0] === "string" && call[0].includes(CHANNEL_WARNING),
  );
  expect(warned).toBe(false);
}

describe("cron --channel type hint", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    hoisted.callGatewayFromCli.mockReset();
    // enabled:true suppresses the unrelated "scheduler disabled" warning.
    hoisted.callGatewayFromCli.mockResolvedValue({ ok: true, enabled: true });
    // The thin CLI client loads no channel plugin runtimes; recognition relies on
    // the bundled channel catalog (slack/telegram/... are known without this mock).
    hoisted.listChannelPluginsMock.mockReset();
    hoisted.listChannelPluginsMock.mockReturnValue([]);
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  });

  // Restore between tests so re-spied runtime.error does not accumulate calls
  // across cases (a stacked spy would carry a prior test's warning).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns but still submits `cron edit --channel <channel-id>` with a --to hint", async () => {
    await createEditProgram().parseAsync(["edit", "job-1", "--channel", "C0BFYTH0BSP"], {
      from: "user",
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"C0BFYTH0BSP" is not a recognized channel type for --channel'),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("pass it with --to instead"));
    // Non-blocking: the value still reaches the Gateway, which is authoritative.
    expect(hoisted.callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { delivery: { channel: "C0BFYTH0BSP" } },
    });
  });

  it("warns on `cron edit --failure-alert-channel <channel-id>` with a --failure-alert-to hint", async () => {
    await createEditProgram().parseAsync(
      ["edit", "job-1", "--failure-alert-channel", "C0BFYTH0BSP"],
      { from: "user" },
    );

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '"C0BFYTH0BSP" is not a recognized channel type for --failure-alert-channel',
      ),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("pass it with --failure-alert-to instead"),
    );
    expect(hoisted.callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { failureAlert: { channel: "c0bfyth0bsp" } },
    });
  });

  it("does not warn for a bundled channel type on `cron edit --channel slack`", async () => {
    await createEditProgram().parseAsync(["edit", "job-1", "--channel", "slack"], { from: "user" });

    expectNoChannelWarning(errorSpy);
    expect(hoisted.callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { delivery: { channel: "slack" } },
    });
  });

  it("recognizes bundled channel types case-insensitively (--failure-alert-channel Slack)", async () => {
    await createEditProgram().parseAsync(["edit", "job-1", "--failure-alert-channel", "Slack"], {
      from: "user",
    });

    expectNoChannelWarning(errorSpy);
    expect(hoisted.callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { failureAlert: { channel: "slack" } },
    });
  });

  it("recognizes a loaded external (non-bundled) channel plugin id without warning", async () => {
    hoisted.listChannelPluginsMock.mockReturnValue([{ id: "acme" }]);

    await createEditProgram().parseAsync(["edit", "job-1", "--channel", "acme"], { from: "user" });

    expectNoChannelWarning(errorSpy);
    expect(hoisted.callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { delivery: { channel: "acme" } },
    });
  });

  it("does not warn on `cron edit` with no channel flag", async () => {
    await createEditProgram().parseAsync(["edit", "job-1", "--enable"], { from: "user" });

    expectNoChannelWarning(errorSpy);
    expect(hoisted.callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { enabled: true },
    });
  });

  it("warns but still submits `cron add --channel <channel-id>`", async () => {
    await createAddProgram().parseAsync(
      [
        "add",
        "My Job",
        "--every",
        "10m",
        "--message",
        "hi",
        "--agent",
        "a1",
        "--announce",
        "--channel",
        "C0BFYTH0BSP",
      ],
      { from: "user" },
    );

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"C0BFYTH0BSP" is not a recognized channel type for --channel'),
    );
    expect(hoisted.callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({
        delivery: expect.objectContaining({ channel: "C0BFYTH0BSP" }),
      }),
    );
  });

  it("does not warn for a bundled channel type on `cron add --channel slack`", async () => {
    await createAddProgram().parseAsync(
      [
        "add",
        "My Job",
        "--every",
        "10m",
        "--message",
        "hi",
        "--agent",
        "a1",
        "--announce",
        "--channel",
        "slack",
      ],
      { from: "user" },
    );

    expectNoChannelWarning(errorSpy);
    expect(hoisted.callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({
        delivery: expect.objectContaining({ channel: "slack" }),
      }),
    );
  });

  it("does not warn on `cron add` with the default channel (no --channel)", async () => {
    await createAddProgram().parseAsync(
      ["add", "My Job", "--every", "10m", "--message", "hi", "--agent", "a1"],
      { from: "user" },
    );

    expectNoChannelWarning(errorSpy);
    expect(hoisted.callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({ name: "My Job" }),
    );
  });
});
