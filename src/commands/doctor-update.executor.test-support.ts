// Real process transport shared by the public Doctor ownership regressions.
import path from "node:path";
import { vi } from "vitest";
import type { UpdateCommandOptions } from "../cli/update-cli/shared.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutorChild,
} from "../cli/update-cli/update-command-executor.js";

export async function runDoctorUpdateChild(
  run: NonNullable<UpdateCommandOptions["run"]>,
  body: string,
  payload: Record<string, unknown>,
  onOutput?: (text: string) => void,
) {
  const fence = run.executorFence;
  if (!fence) {
    throw new Error("Doctor public caller did not provide its original executor");
  }
  const { runUtf8CommandWithTimeout } =
    await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  const script = `
    import fs from "node:fs";
    import {setTimeout} from "node:timers/promises";
    import {withDelegatedUpdateCommandExecutor} from ${JSON.stringify(new URL("../cli/update-cli/update-command-executor.ts", import.meta.url).href)};
    const {grant,payload}=JSON.parse(fs.readFileSync(0,"utf8"));
    await withDelegatedUpdateCommandExecutor(grant,grant.runId,grant.root,async fence=>{${body}});
  `;
  return withUpdateCommandExecutorChild(
    fence,
    captureUpdateCommandExecutorAuthority(fence).installKey,
    async (grant, beforeInput) => {
      const result = await runUtf8CommandWithTimeout(
        [
          process.execPath,
          "--import",
          path.resolve("scripts/tsx.mjs"),
          "--input-type=module",
          "-e",
          script,
        ],
        {
          input: JSON.stringify({ grant, payload }),
          beforeInput,
          baseEnv: {},
          env: run.env,
          timeoutMs: 20_000,
          killProcessTree: true,
          requireProcessTreeExtinction: true,
          onOutputChunk: (chunk) => onOutput?.(chunk.toString()),
        },
      );
      if (
        result.code !== 0 ||
        result.termination !== "exit" ||
        result.signal !== null ||
        result.killed ||
        (result.cleanup !== "normal" && result.cleanup !== "cooperative")
      ) {
        const { code, signal, killed, termination, cleanup } = result;
        throw Object.assign(
          new Error(
            `Doctor child did not settle successfully: ${JSON.stringify({ code, signal, killed, termination, cleanup })}${result.stderr ? `\n${result.stderr}` : ""}`,
          ),
          { result },
        );
      }
      return result;
    },
  );
}
