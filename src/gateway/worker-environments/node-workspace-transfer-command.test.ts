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
    ["default", result, undefined],
    ["guarded", result, undefined],
    ["explicit override", result, undefined],
    ["exit code", { ...result, code: 1 }, "transfer failed"],
    ["termination", { ...result, termination: "timeout" }, "transfer failed"],
    ["manifest", { ...result, stdout: `sha256:${"b".repeat(64)}` }, "transfer failed"],
    ["closed authority", result, "initiating turn closed"],
  ] as const)("validates the %s transfer result and budget", async (mode, received, failure) => {
    let current = true;
    const timeoutMs = mode === "explicit override" ? 42_000 : 600_000;
    const command =
      mode === "default"
        ? undefined
        : {
            assertCurrent: () => {
              if (!current) {
                throw new Error("initiating turn closed");
              }
            },
            ...(mode === "explicit override" ? { timeoutMs } : {}),
          };
    const exec = vi.fn(async () => {
      current = mode !== "closed authority";
      return received;
    });
    const pending = createNodeWorkspaceTransferCommand(exec)(input, "transfer failed", command);
    if (failure) {
      await expect(pending).rejects.toThrow(failure);
    } else {
      await expect(pending).resolves.toBe(result);
    }
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs,
        transfer: input,
        transportRetry: "never",
        ...(command?.assertCurrent ? { assertCurrent: command.assertCurrent } : {}),
      }),
    );
  });
});
