import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { addGatewayVerifyCommand } from "./register-verify.js";

const mocks = vi.hoisted(() => ({
  verifyGatewayStartup: vi.fn(),
  runtime: { writeJson: vi.fn(), exit: vi.fn() },
}));

vi.mock("../../gateway/startup-verify.js", () => ({
  verifyGatewayStartup: () => mocks.verifyGatewayStartup(),
}));
vi.mock("../../runtime.js", () => ({ defaultRuntime: mocks.runtime }));

function register(program: Command): void {
  addGatewayVerifyCommand(program.command("gateway"));
}

describe("gateway verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prints the startup proof as JSON", async () => {
    const proof = { ok: true, protocol: "openclaw.gateway.verify", protocolVersion: 1 };
    mocks.verifyGatewayStartup.mockResolvedValue(proof);
    await runRegisteredCli({ register, argv: ["gateway", "verify", "--json"] });
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(proof);
  });

  it("returns a stable machine failure", async () => {
    mocks.verifyGatewayStartup.mockRejectedValue(new Error("config invalid"));
    await runRegisteredCli({ register, argv: ["gateway", "verify", "--json"] });
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
      ok: false,
      protocol: "openclaw.gateway.verify",
      protocolVersion: 1,
      error: "config invalid",
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });
});
