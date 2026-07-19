import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerUsersCli } from "./users-cli.js";

const callGatewayFromCli = vi.hoisted(() => vi.fn());
vi.mock("./gateway-rpc.js", () => ({ callGatewayFromCli }));

afterEach(() => {
  callGatewayFromCli.mockReset();
});

describe("registerUsersCli", () => {
  it("routes link-email through the admin gateway method", async () => {
    const program = new Command().exitOverride();
    registerUsersCli(program);

    await program.parseAsync([
      "node",
      "openclaw",
      "users",
      "link-email",
      "Ada@example.com",
      "--to",
      "p-1",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "users.linkEmail",
      expect.objectContaining({ to: "p-1" }),
      { email: "Ada@example.com", targetProfileId: "p-1" },
      { scopes: ["operator.admin"] },
    );
  });

  it("prints the link result as JSON when requested", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    callGatewayFromCli.mockResolvedValue({ profile: { id: "p-1" } });
    const program = new Command().exitOverride();
    registerUsersCli(program);

    await program.parseAsync([
      "node",
      "openclaw",
      "users",
      "link-email",
      "Ada@example.com",
      "--to",
      "p-1",
      "--json",
    ]);

    expect(output).toHaveBeenCalledWith('{\n  "profile": {\n    "id": "p-1"\n  }\n}\n');
  });
});
