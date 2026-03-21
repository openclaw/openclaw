import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const execFileAsync = promisify(execFile);

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
