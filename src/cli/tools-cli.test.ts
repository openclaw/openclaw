import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerToolsCli } from "./tools-cli.js";

const mocks = vi.hoisted(() => ({ call: vi.fn(), writeJson: vi.fn(), log: vi.fn() }));
// mock-isolation: Exercise command parsing without a Gateway or operator configuration.
vi.mock("./gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-rpc.js")>()),
  callGatewayFromCli: mocks.call,
}));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: { writeJson: mocks.writeJson, log: mocks.log },
}));
afterEach(() => vi.clearAllMocks());

function run(args: string[]) {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerToolsCli(program);
  return program.parseAsync(["tools", "usage", ...args], { from: "user" });
}

it.each([
  [["status"], "status", { agentId: "main", limit: 20 }],
  [["import", "--dry-run"], "import", { agentId: "main", sinceDays: 90, dryRun: true }],
  [
    ["import", "--agent", "work", "--since", "14"],
    "import",
    { agentId: "work", sinceDays: 14, dryRun: false },
  ],
  [["reset", "--agent", "work"], "reset", { agentId: "work" }],
  [
    ["status", "--session", "agent:main:example", "--limit", "3"],
    "status",
    { agentId: "main", limit: 3, sessionKey: "agent:main:example" },
  ],
] as const)("routes %j through the admin-only Gateway API", async (args, method, params) => {
  const result = { agentId: params.agentId, marker: "complete report" };
  mocks.call.mockResolvedValue(result);
  await run([...args, "--json"]);
  expect(mocks.call).toHaveBeenCalledWith(
    `toolUsage.${method}`,
    expect.objectContaining({ json: true }),
    params,
    { scopes: ["operator.admin"] },
  );
  expect(mocks.writeJson).toHaveBeenCalledExactlyOnceWith(result, 2);
  expect(mocks.log).not.toHaveBeenCalled();
});

it.each(["0", "91", "2.5", "not-a-number"])(
  "rejects invalid import days %s before RPC",
  async (days) => {
    await expect(run(["import", "--since", days])).rejects.toThrow(
      "Expected an integer between 1 and 90",
    );
    expect(mocks.call).not.toHaveBeenCalled();
  },
);
