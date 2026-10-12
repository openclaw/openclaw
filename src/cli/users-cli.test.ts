import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerUsersCli } from "./users-cli.js";

const callGatewayFromCli = vi.hoisted(() => vi.fn());
vi.mock("./gateway-rpc.js", () => ({ callGatewayFromCli }));

afterEach(() => {
  vi.restoreAllMocks();
  callGatewayFromCli.mockReset();
});

function createProgram(response: unknown) {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  callGatewayFromCli.mockResolvedValue(response);
  const program = new Command().exitOverride();
  registerUsersCli(program);
  return { output, program };
}

describe("registerUsersCli", () => {
  it("reports the authoritative linked profile and uses the admin gateway method", async () => {
    const { output, program } = createProgram({
      profile: {
        id: "p-1\nshadow",
        displayName: "Ada\tadmin\u001b[2J",
        emails: ["ada@example.com\nnext@example.com"],
      },
    });
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
    expect(output).toHaveBeenCalledWith(
      "p-1\\nshadow\tAda\\tadmin\tada@example.com\\nnext@example.com\n",
    );
  });

  it("reports an empty user profile list", async () => {
    const { output, program } = createProgram({ profiles: [] });

    await program.parseAsync(["node", "openclaw", "users", "list"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "users.list",
      expect.any(Object),
      {},
      { scopes: ["operator.read"] },
    );
    expect(output).toHaveBeenCalledWith("No user profiles found.\n");
  });

  it("preserves the empty profile list JSON response", async () => {
    const { output, program } = createProgram({ profiles: [] });

    await program.parseAsync(["node", "openclaw", "users", "list", "--json"]);

    expect(output).toHaveBeenCalledWith('{\n  "profiles": []\n}\n');
  });

  it("prints the link result as JSON when requested", async () => {
    const { output, program } = createProgram({ profile: { id: "p-1" } });

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

  it("merges profiles through the admin RPC and explains the surviving identity", async () => {
    const { output, program } = createProgram({
      profile: { id: "p-survivor", displayName: "Ada" },
      movedAliasKinds: ["channel", "provider"],
    });

    await program.parseAsync([
      "node",
      "openclaw",
      "users",
      "merge",
      "p-retired\nforged",
      "--into",
      "p-survivor",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "users.merge",
      expect.objectContaining({ into: "p-survivor" }),
      { sourceProfileId: "p-retired\nforged", targetProfileId: "p-survivor" },
      { scopes: ["operator.admin"] },
    );
    const text = output.mock.calls.map(([chunk]) => chunk).join("");
    expect(text).toContain("Survivor: p-survivor\n");
    expect(text).toContain("Retired profile: p-retired\\nforged\n");
    expect(text).toContain(
      "History keeps its original attribution; logins, links, and accounts follow the survivor.",
    );
  });

  it("preserves the merge RPC result in JSON output", async () => {
    const result = {
      profile: { id: "p-survivor", emails: [] },
      movedAliasKinds: ["channel"],
    };
    const { output, program } = createProgram(result);

    await program.parseAsync([
      "node",
      "openclaw",
      "users",
      "merge",
      "p-retired",
      "--into",
      "p-survivor",
      "--json",
    ]);

    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual(result);
  });
});
