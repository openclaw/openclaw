import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const shellTool = {
  name: "shell",
  description:
    "Run any command line program installed on the system (bash, cmd, powershell, git, node, pnpm, python, etc) and return stdout/stderr.",

  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "number" },
    },
    required: ["command"],
  },

  async run(args: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
  }) {
    const { stdout, stderr } = await execAsync(args.command, {
      cwd: args.cwd,
      timeout: args.timeoutMs ?? 120000,
      shell: true,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      command: args.command,
      cwd: args.cwd || process.cwd(),
      stdout,
      stderr,
      success: !stderr,
    };
  },
};