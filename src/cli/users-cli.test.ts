import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
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
  return {
    output,
    run: (...args: string[]) => program.parseAsync(["users", ...args], { from: "user" }),
  };
}

it("reports the authoritative linked profile and uses the admin gateway method", async () => {
  const { output, run } = createProgram({
    profile: {
      id: "p-1\nshadow",
      displayName: "Ada\tadmin\u001b[2J",
      emails: ["ada@example.com\nnext@example.com"],
    },
  });
  await run("link-email", "Ada@example.com", "--to", "p-1");

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
  const { output, run } = createProgram({ profiles: [] });
  await run("list");

  expect(callGatewayFromCli).toHaveBeenCalledWith(
    "users.list",
    expect.any(Object),
    {},
    { scopes: ["operator.read"] },
  );
  expect(output).toHaveBeenCalledWith("No user profiles found.\n");
});

it("merges profiles through the admin RPC and explains the surviving identity", async () => {
  const { output, run } = createProgram({
    profile: { id: "p-survivor" },
  });
  await run("merge", "p-retired\nforged", "--into", "p-survivor");

  expect(callGatewayFromCli).toHaveBeenCalledWith(
    "users.merge",
    expect.objectContaining({ into: "p-survivor" }),
    { sourceProfileId: "p-retired\nforged", targetProfileId: "p-survivor" },
    { scopes: ["operator.admin"] },
  );
  expect(output).toHaveBeenCalledWith(
    "Survivor: p-survivor\nRetired profile: p-retired\\nforged\n" +
      "History keeps its original attribution; logins, links, and accounts follow the survivor.\n",
  );
});

it.each([
  {
    command: "link-email",
    args: ["Ada@example.com", "--to", "p-1"],
    result: { profile: { id: "p-1" } },
  },
  {
    command: "merge",
    args: ["p-retired", "--into", "p-survivor"],
    result: { profile: { id: "p-survivor", emails: [] }, movedAliasKinds: ["channel"] },
  },
])("prints the complete $command result as JSON", async ({ command, args, result }) => {
  const { output, run } = createProgram(result);
  await run(command, ...args, "--json");
  expect(output.mock.calls).toEqual([[`${JSON.stringify(result, null, 2)}\n`]]);
});
