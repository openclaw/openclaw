import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Allowlist of binaries exec.run is permitted to invoke.
 * Only tmux management commands and the shell wrapper used to
 * fan out tmux list-sessions across multiple sockets are needed
 * by the terminal control UI. Restricting here prevents an
 * authenticated operator from escalating to arbitrary execution
 * on the gateway host.
 */
const EXEC_ALLOWED_COMMANDS = new Set(["tmux", "sh"]);

export const execRunHandlers: GatewayRequestHandlers = {
  "exec.run": async ({ params, respond }) => {
    const command = typeof params.command === "string" ? params.command.trim() : "";
    const args = Array.isArray(params.args)
      ? params.args.filter((a): a is string => typeof a === "string")
      : [];
    if (!command) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "command is required"));
      return;
    }
    // Security: only allow the specific binaries required by the terminal UI.
    if (!EXEC_ALLOWED_COMMANDS.has(command)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `exec.run: command "${command}" is not permitted (allowed: ${[...EXEC_ALLOWED_COMMANDS].join(", ")})`,
        ),
      );
      return;
    }
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: 15_000,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      });
      respond(true, { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 }, undefined);
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number | string };
      respond(
        true,
        {
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? String(err),
          exitCode: typeof e.code === "number" ? e.code : 1,
        },
        undefined,
      );
    }
  },
};
