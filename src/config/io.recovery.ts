import path from "node:path";
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";
import { readExistingStateRootMode } from "../infra/private-dir-mode.js";
import { persistBoundedClobberedConfigSnapshot } from "./io.clobber-snapshot.js";
import type { ConfigIoContext } from "./io.context.js";
import {
  parseConfigJson5,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
} from "./io.read-helpers.js";
import { createConfigFileWriteGuard } from "./io.write-safety.js";
import { resolveIsConfigReadOnly, resolveStateDir } from "./paths.js";
import type { ConfigFileSnapshot } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";
import { captureConfigWriteLockGuard, withConfigWriteLock } from "./write-lock.js";

function findJsonRootSuffix(raw: string): { raw: string; parsed: unknown } | null {
  if (/^\s*(?:\{|\[)/.test(raw)) {
    return null;
  }
  let offset = 0;
  while (offset < raw.length) {
    const nextNewline = raw.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? raw.length : nextNewline + 1;
    const line = raw.slice(offset, lineEnd);
    if (/^\s*(?:\{|\[)/.test(line)) {
      const candidate = raw.slice(offset);
      const parsed = parseConfigJson5(candidate);
      return parsed.ok ? { raw: candidate, parsed: parsed.parsed } : null;
    }
    offset = lineEnd;
  }
  return null;
}

export function inspectConfigJsonRootSuffixWithContext(
  context: ConfigIoContext,
  raw: string,
  assertRecoveryCandidate?: (config: unknown) => void,
) {
  const suffixRecovery = findJsonRootSuffix(raw);
  if (!suffixRecovery) {
    return null;
  }
  assertRecoveryCandidate?.(suffixRecovery.parsed);
  let resolved: unknown;
  try {
    resolved = resolveConfigIncludesForRead(
      suffixRecovery.parsed,
      context.configPath,
      context.deps,
    );
  } catch {
    return null;
  }
  const resolution = resolveConfigForRead(
    resolved,
    context.deps.env,
    context.deps.lowerPrecedenceEnv,
  );
  assertRecoveryCandidate?.(resolution.resolvedConfigRaw);
  return { ...suffixRecovery, resolvedConfigRaw: resolution.resolvedConfigRaw };
}

export async function recoverConfigFromJsonRootSuffixWithContext(
  context: ConfigIoContext,
  snapshot: ConfigFileSnapshot,
  assertRecoveryCandidate?: (config: unknown) => void,
): Promise<boolean> {
  if (resolveIsConfigReadOnly(context.deps.env)) {
    return false;
  }
  if (!snapshot.exists || snapshot.valid || typeof snapshot.raw !== "string") {
    return false;
  }
  const raw = snapshot.raw;
  return withConfigWriteLock(
    context.configPath,
    () => recoverConfigJsonRootSuffixUnderLock(context, snapshot, raw, assertRecoveryCandidate),
    context.deps.env,
  );
}

async function recoverConfigJsonRootSuffixUnderLock(
  context: ConfigIoContext,
  snapshot: ConfigFileSnapshot,
  raw: string,
  assertRecoveryCandidate?: (config: unknown) => void,
): Promise<boolean> {
  const suffixRecovery = inspectConfigJsonRootSuffixWithContext(
    context,
    raw,
    assertRecoveryCandidate,
  );
  if (!suffixRecovery) {
    return false;
  }
  const validated = validateConfigObjectWithPlugins(suffixRecovery.resolvedConfigRaw, {
    ...context.pathResolution,
    pluginValidation: context.options.pluginValidation,
    sourceRaw: suffixRecovery.parsed,
  });
  if (!validated.ok) {
    return false;
  }
  const writeGuard = createConfigFileWriteGuard(
    context.configPath,
    context.deps.fs,
    captureConfigWriteLockGuard(context.configPath),
    { snapshot, includeGraph: { hashes: {}, targets: {} } },
  );
  writeGuard.assertBeforeMutation();
  const clobberedPath = await persistBoundedClobberedConfigSnapshot({
    deps: context.deps,
    configPath: context.configPath,
    raw,
    observedAt: new Date().toISOString(),
  });
  if (clobberedPath === null) {
    context.deps.logger.warn(
      `Config prefix recovery deferred: ${context.configPath}; original config snapshot could not be saved. Retry recovery.`,
    );
    return false;
  }
  // Recovery must publish by rename; a copy fallback can truncate the live config.
  await replaceFileAtomic({
    filePath: context.configPath,
    content: suffixRecovery.raw,
    dirMode:
      readExistingStateRootMode(
        path.dirname(context.configPath),
        resolveStateDir(context.deps.env, context.deps.homedir),
        context.deps.fs,
      ) ?? 0o700,
    mode: 0o600,
    tempPrefix: path.basename(context.configPath),
    fileSystem: writeGuard.fileSystem,
    assertBeforeMutation: writeGuard.assertBeforeMutation,
    onDestinationState: writeGuard.onDestinationState,
  });
  context.deps.logger.warn(
    `Config auto-stripped non-JSON prefix: ${context.configPath} (original saved as ${clobberedPath})`,
  );
  return true;
}
