/** Config IO adapter used by secrets apply/configure flows. */
import path from "node:path";
import { createConfigIO } from "../config/config.js";
import { privateFileStoreSync } from "../infra/private-file-store.js";
import { replaceFileAtomicSync } from "../infra/replace-file.js";

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
export function writeTextFileAtomic(pathname: string, value: string, mode = 0o600): void {
  if (mode !== 0o600) {
    replaceFileAtomicSync({
      filePath: pathname,
      content: value,
      mode,
      tempPrefix: ".openclaw-secrets",
    });
    return;
  }
  privateFileStoreSync(path.dirname(pathname)).writeText(path.basename(pathname), value);
}
