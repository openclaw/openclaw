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

it.each([
  [
    ["link-email", "Ada@example.com", "--to", "p-1"],
    {
      profile: {
        id: "p-1\nshadow",
        displayName: "Ada\tadmin\u001b[2J",
        emails: ["ada@example.com\nnext@example.com"],
      },
    },
    "users.linkEmail",
    expect.objectContaining({ to: "p-1" }),
    { email: "Ada@example.com", targetProfileId: "p-1" },
    "operator.admin",
    "p-1\\nshadow\tAda\\tadmin\tada@example.com\\nnext@example.com\n",
  ],
  [
    ["list"],
    { profiles: [] },
    "users.list",
    expect.any(Object),
    {},
    "operator.read",
    "No user profiles found.\n",
  ],
  [
    ["merge", "p-retired\nforged", "--into", "p-survivor"],
    { profile: { id: "p-survivor" } },
    "users.merge",
    expect.objectContaining({ into: "p-survivor" }),
    { sourceProfileId: "p-retired\nforged", targetProfileId: "p-survivor" },
    "operator.admin",
    "Survivor: p-survivor\nRetired profile: p-retired\\nforged\n" +
      "History keeps its original attribution; logins, links, and accounts follow the survivor.\n",
  ],
] as const)(
  "routes %j with scoped authority and sanitized output",
  async (args, response, method, options, params, scope, text) => {
    const { output, run } = createProgram(response);
    await run(...args);
    expect(callGatewayFromCli).toHaveBeenCalledWith(method, options, params, { scopes: [scope] });
    expect(output).toHaveBeenCalledWith(text);
  },
);

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
