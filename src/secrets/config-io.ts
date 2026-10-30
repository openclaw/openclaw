/** Config IO adapter used by secrets apply/configure flows. */
import path from "node:path";
import { replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import { createConfigIO } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { readExistingStateRootMode } from "../infra/private-dir-mode.js";
import { writePrivateTextFileAtomicSync } from "../infra/private-file-store.js";

const silentConfigIoLogger = {
  error: () => {},
  warn: () => {},
} as const;

/**
 * Creates config I/O for secrets commands with config-loader logging suppressed.
 */
export function createSecretsConfigIO(params: {
  env: NodeJS.ProcessEnv;
}): ReturnType<typeof createConfigIO> {
  // Secrets command output is owned by the CLI command so --json stays machine-parseable.
  return createConfigIO({
    env: params.env,
    logger: silentConfigIoLogger,
  });
}

/**
 * Atomically writes secret-adjacent text, using the private store for default 0600 files.
 */
export function writeTextFileAtomic(
  pathname: string,
  value: string,
  mode = 0o600,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const stateDir = resolveStateDir(env);
  if (mode !== 0o600) {
    replaceFileAtomicSync({
      filePath: pathname,
      content: value,
      mode,
      dirMode: readExistingStateRootMode(path.dirname(pathname), stateDir),
      tempPrefix: ".openclaw-secrets",
    });
    return;
  }
  writePrivateTextFileAtomicSync(pathname, value, stateDir);
}
