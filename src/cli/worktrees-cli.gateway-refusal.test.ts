import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { registerWorktreesCli } from "./worktrees-cli.js";

const runWithLocalStateOwner = vi.hoisted(() => vi.fn());
vi.mock("./local-state-owner.js", () => ({ runWithLocalStateOwner }));

async function run(args: string[]) {
  const program = new Command().name("openclaw").exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  registerWorktreesCli(program);
  return program.parseAsync(["worktrees", ...args], { from: "user" });
}

// What the state owner raises when the running Gateway refuses a worktree mutation.
const ownerError = (message: string, details: Record<string, unknown>) =>
  new Error(`Gateway owning /state on local port 18789 could not complete it: ${message}.`, {
    cause: Object.assign(new Error(message), { name: "GatewayClientRequestError", details }),
  });

it.each([
  [["remove", "nope"], "unknown active worktree: nope"],
  [["restore", "nope"], "worktree nope is not restorable"],
])("reports %j refused by a running Gateway as %j", async (args, message) => {
  runWithLocalStateOwner.mockRejectedValueOnce(
    ownerError(message, { reason: "WORKTREE_NOT_FOUND", mutationAccepted: false }),
  );
  await expect(run(args)).rejects.toMatchObject({ humanOutput: message, machineOutput: message });

  const other = ownerError("registry is busy", { mutationAccepted: false });
  runWithLocalStateOwner.mockRejectedValueOnce(other);
  await expect(run(args)).rejects.toBe(other);
});
