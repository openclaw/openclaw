import fs from "node:fs/promises";
import { redactTextForSupport } from "../logging/diagnostic-support-redaction.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { UpdatePreMutationError } from "./update-pre-mutation-error.js";

/** Preserve startup diagnostics before the failed helper's private directory is removed. */
export async function readHandoffStartupFailure(
  error: unknown,
  logPath: string,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  let tail: string;
  try {
    const log = await fs.open(logPath, "r");
    try {
      const { size } = await log.stat();
      const buffer = Buffer.alloc(Math.min(size, 8192));
      const { bytesRead } = await log.read(buffer, 0, buffer.length, size - buffer.length);
      tail = buffer.toString("utf8", 0, bytesRead);
      // A partial first line may have lost the key identifying a secret value.
      if (size > buffer.length) {
        const newline = tail.indexOf("\n");
        tail = newline < 0 ? "" : tail.slice(newline + 1);
      }
    } finally {
      await log.close();
    }
  } catch {
    return error;
  }
  const lines = redactTextForSupport(tail)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) => line && !/^at |^Node\.js v|(?:^|\] )managed update helper completed/u.test(line),
    );
  const primary = lines.find((line) =>
    /\b(?:\w*Error(?::| \[)|Node \S+ is unsupported)/u.test(line),
  );
  const diagnostics = [...new Set([...(primary ? [primary] : []), ...lines.slice(-2)])].map(
    (line) => createUpdateErrorFact("managed-service", new Error(line), env),
  );
  if (!diagnostics.length) {
    return error;
  }
  const cause = createUpdateErrorFact("managed-service", error, env);
  return new UpdatePreMutationError(
    "managed-service-handoff-failed",
    [cause.message, ...diagnostics.map((fact) => fact.message)].join("\n"),
    { cause: error, failureFacts: [cause, ...diagnostics] },
  );
}
