import { exec, type ExecException } from "node:child_process";

function normalize(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function extractOutput(stdout: unknown, stderr: unknown) {
  // handle mock object form (z.B. { stdout, stderr })
  if (stdout && typeof stdout === "object") {
    const obj = stdout as Record<string, unknown>;
    return {
      stdout: normalize(obj.stdout),
      stderr: normalize(obj.stderr),
    };
  }

  return {
    stdout: normalize(stdout),
    stderr: normalize(stderr),
  };
}

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
    },
  ) {
    const { command, cwd, timeoutMs } = args;

    return new Promise((resolve) => {
      const options = {
        cwd: cwd || process.cwd(),
        timeout: timeoutMs ?? 30_000,
      };

      exec(command, options, (error: ExecException | null, stdout: string, stderr: string) => {
        const { stdout: out, stderr: err } = extractOutput(stdout, stderr);

        if (!error) {
          return resolve({
            data: {
              stdout: out,
              stderr: err,
              success: true,
            },
          });
        }

        const errOut = extractOutput(error?.stdout as unknown, error?.stderr as unknown);

        return resolve({
          data: {
            stdout: errOut.stdout || out,
            stderr: errOut.stderr || err,
            success: false,
          },
        });
      });
    });
  },
};
