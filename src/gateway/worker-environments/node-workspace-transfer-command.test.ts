import { describe, expect, it, vi } from "vitest";
import { createNodeWorkspaceTransferCommand } from "./node-workspace-transfer-command.js";

const manifestRef = `sha256:${"a".repeat(64)}`;
const input = { direction: "download", token: "test-token", manifestRef } as const;
const result = {
  workspaceDir: "/node/workspace",
  stdout: manifestRef,
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
} as const;

describe("node workspace transfer command", () => {
  it.each([
    { name: "default", command: undefined, timeoutMs: 600_000 },
    { name: "guarded", command: { assertCurrent: () => {} }, timeoutMs: 600_000 },
    {
      name: "explicit override",
      command: { assertCurrent: () => {}, timeoutMs: 42_000 },
      timeoutMs: 42_000,
    },
  ])("preserves the $name transfer budget", async ({ command, timeoutMs }) => {
    const exec = vi.fn(async () => result);
    await createNodeWorkspaceTransferCommand(exec)(input, "transfer failed", command);
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs,
        transfer: input,
        transportRetry: "never",
        ...(command?.assertCurrent ? { assertCurrent: command.assertCurrent } : {}),
      }),
    );
  });

  it.each([
    { ...result, code: 1 },
    { ...result, termination: "timeout" as const },
    { ...result, stdout: `sha256:${"b".repeat(64)}` },
  ])("rejects an unsuccessful or mismatched result", async (received) => {
    await expect(
      createNodeWorkspaceTransferCommand(async () => received)(input, "transfer failed", {
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("transfer failed");
  });

  it("rejects a late result after initiating authority closes", async () => {
    let current = true;
    const transfer = createNodeWorkspaceTransferCommand(async () => {
      current = false;
      return result;
    });
    await expect(
      transfer(input, "transfer failed", {
        assertCurrent: () => {
          if (!current) {
            throw new Error("initiating turn closed");
          }
        },
      }),
    ).rejects.toThrow("initiating turn closed");
  });
});
