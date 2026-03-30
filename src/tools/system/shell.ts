import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const shellTool = {
  name: "shell",
  description: "Execute a shell command",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "number" },
    },
    required: ["command"],
  },

  async execute(
    _toolCallId: string,
    args: {
      command: string;
      cwd?: string;
      timeoutMs?: number;
    }
  ) {
    const { command, cwd, timeoutMs } = args;

    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd || process.cwd(),
      timeout: timeoutMs ?? 30_000,
      shell: "cmd.exe", // Windows safe
    });

    return {
      data: {
        command,
        cwd: cwd || process.cwd(),
        stdout: String(stdout),
        stderr: String(stderr),
        success: true,
      },
    };
  },
};