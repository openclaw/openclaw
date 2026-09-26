/** Transactional LaunchAgent installation, staging, rollback, and removal. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { isCurrentProcessInsideLaunchdService } from "./launchd-current-service.js";
import {
  execLaunchctl,
  formatLaunchctlResultDetail,
  isLaunchctlNotLoaded,
} from "./launchd-exec.js";
import { assertValidLaunchAgentLabel, resolveLaunchAgentLabel } from "./launchd-label.js";
import { decodeLaunchdPlistMetadata, remainingLaunchdPlistReadTimeout } from "./launchd-plist.js";
import {
  preserveLaunchAgentRecoveryDefinition,
  verifyLaunchAgentRecoveryDefinition,
  type LaunchAgentRecoveryState,
} from "./launchd-recovery-definition.js";
import { readLaunchAgentArtifactState } from "./launchd-registration.js";
import {
  bootstrapLaunchAgentOrThrow,
  isLaunchAgentEnabled,
  probeLaunchAgentState,
  resolveLaunchAgentGuiDomain,
} from "./launchd-runtime.js";
import {
  captureLaunchAgentInstallFiles,
  readExistingLaunchAgentPlist,
  readLaunchAgentProgramArgumentsAtPath,
  resolvePreCanonicalLaunchAgentPlistPath,
  resolveLaunchAgentPlistPath,
  writeLaunchAgentPlist,
} from "./launchd-service-files.js";
import { assertNoSystemLaunchDaemonOwnership } from "./launchd-system.js";
import { formatLine, normalizeWindowsPathSeparators, writeFormattedLines } from "./output.js";
import { publishServiceFile } from "./service-stage.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceEnv,
  GatewayServiceReadOptions,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
} from "./service-types.js";
import {
  assertGatewayServiceUpdateCurrent,
  withGatewayServiceInstallationRecovery,
} from "./service-update-authority.js";

export async function uninstallLaunchAgent({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  await assertExternalLaunchAgentMutation(env, "uninstall");
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(env);
  let preflight: LaunchAgentRemovalPreflight;
  try {
    preflight = await preflightLaunchAgentPlistRemoval(env, label);
  } catch (error) {
    throw createLaunchAgentRemovalError(error);
  }
  const serviceTarget = `${domain}/${label}`;
  const probe = await probeLaunchAgentState(serviceTarget);
  if (probe.state !== "not-loaded") {
    const bootout = await execLaunchctl(["bootout", serviceTarget]);
    if (bootout.code !== 0 && !isLaunchctlNotLoaded(bootout)) {
      throw new Error(`launchctl bootout failed: ${formatLaunchctlResultDetail(bootout)}`);
    }
  }

  if (preflight.existingPlistPaths.length === 0) {
    stdout.write(`LaunchAgent not found at ${preflight.canonicalPlistPath}\n`);
    return;
  }

  for (const plistPath of preflight.existingPlistPaths) {
    await moveLaunchAgentPlistToTrash({ plistPath, label, stdout });
  }
}

async function moveLaunchAgentPlistToTrash(params: {
  plistPath: string;
  label: string;
  stdout: GatewayServiceManageArgs["stdout"];
}): Promise<void> {
  const launchAgentsDir = path.posix.dirname(normalizeWindowsPathSeparators(params.plistPath));
  const libraryDir = path.posix.dirname(launchAgentsDir);
  const trashDir = path.posix.join(path.posix.dirname(libraryDir), ".Trash");
  const dest = path.join(trashDir, `${params.label}.plist`);
  try {
    await fs.mkdir(trashDir, { recursive: true });
    await fs.rename(params.plistPath, dest);
    params.stdout.write(`${formatLine("Moved LaunchAgent to Trash", dest)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        await fs.lstat(params.plistPath);
      } catch (accessError) {
        if ((accessError as NodeJS.ErrnoException).code === "ENOENT") {
          params.stdout.write(`LaunchAgent not found at ${params.plistPath}\n`);
          return;
        }
        throw createLaunchAgentRemovalError(accessError);
      }
    }
    throw createLaunchAgentRemovalError(error);
  }
}

function createLaunchAgentRemovalError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  return new Error(
    `LaunchAgent removal failed${code ? ` (${code})` : ""}. Check permissions and retry.`,
  );
}
async function currentGatewayLaunchAgentLabel(
  targetEnv: Record<string, string | undefined>,
): Promise<string | undefined> {
  const configuredCurrentLabel = process.env.OPENCLAW_LAUNCHD_LABEL?.trim();
  const candidates = new Set([
    resolveLaunchAgentLabel(targetEnv),
    ...(configuredCurrentLabel ? [assertValidLaunchAgentLabel(configuredCurrentLabel)] : []),
  ]);
  for (const label of candidates) {
    if (await isCurrentProcessInsideLaunchdService(label)) {
      return label;
    }
  }
  return undefined;
}

async function assertExternalLaunchAgentMutation(
  env: Record<string, string | undefined>,
  action: "install" | "uninstall",
): Promise<void> {
  const currentLabel = await currentGatewayLaunchAgentLabel(env);
  if (!currentLabel) {
    return;
  }
  throw new Error(
    `Refusing to ${action} LaunchAgent ${resolveLaunchAgentLabel(env)} from inside ${currentLabel}; run this command from an external shell.`,
  );
}

export async function stageLaunchAgent({
  stdout,
  ...args
}: GatewayServiceInstallArgs): Promise<{ plistPath: string }> {
  const { plistPath, stdoutPath } = await writeLaunchAgentPlist({ ...args, stdout });
  writeFormattedLines(
    stdout,
    [
      { label: "Staged LaunchAgent", value: plistPath },
      { label: "Logs", value: stdoutPath },
    ],
    { leadingBlankLine: true },
  );
  return { plistPath };
}

type RelocatedLaunchAgentPlist = {
  plistPath: string;
  contents: Buffer;
  mode: number;
  command: GatewayServiceCommandConfig;
};

type LaunchAgentRemovalPreflight = {
  canonicalPlistPath: string;
  existingPlistPaths: string[];
};

async function preflightLaunchAgentPlistRemoval(
  env: GatewayServiceEnv,
  label: string,
): Promise<LaunchAgentRemovalPreflight> {
  const canonicalPlistPath = resolveLaunchAgentPlistPath(env);
  const preCanonicalPlistPath = resolvePreCanonicalLaunchAgentPlistPath(env, label);
  const distinctPreCanonicalPath =
    preCanonicalPlistPath === canonicalPlistPath ? undefined : preCanonicalPlistPath;
  if (distinctPreCanonicalPath) {
    await readLaunchAgentArtifactState(distinctPreCanonicalPath, canonicalPlistPath);
  }
  const existing = new Set<string>();
  for (const plistPath of [canonicalPlistPath, distinctPreCanonicalPath]) {
    if (!plistPath) {
      continue;
    }
    try {
      await fs.lstat(plistPath);
      existing.add(plistPath);
    } catch (error) {
      // SAFETY: Node filesystem rejections expose errno-compatible codes when present.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return {
    canonicalPlistPath,
    // Retire the pre-canonical definition first so a partial failure never
    // leaves it as the only rediscoverable LaunchAgent definition.
    existingPlistPaths: [distinctPreCanonicalPath, canonicalPlistPath].filter(
      (plistPath): plistPath is string => Boolean(plistPath && existing.has(plistPath)),
    ),
  };
}

async function readRelocatedLaunchAgentPlistForInstall(params: {
  env: GatewayServiceEnv;
  label: string;
  targetPlistPath: string;
  options?: GatewayServiceReadOptions;
  deadline?: number;
}): Promise<RelocatedLaunchAgentPlist | null> {
  const plistPath = resolvePreCanonicalLaunchAgentPlistPath(params.env, params.label);
  if (plistPath === params.targetPlistPath) {
    return null;
  }
  const registration = await readLaunchAgentArtifactState(plistPath, params.targetPlistPath);
  if (registration?.registrationTarget) {
    return null;
  }
  const snapshot = await readExistingLaunchAgentPlist(plistPath);
  const contents = snapshot?.contents ?? null;
  if (contents === null) {
    return null;
  }
  const metadata = await decodeLaunchdPlistMetadata(
    contents,
    remainingLaunchdPlistReadTimeout(params.deadline),
  ).catch((error: unknown) => {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    return undefined;
  });
  remainingLaunchdPlistReadTimeout(params.deadline);
  const relocatedLabel = metadata?.Label;
  if (typeof relocatedLabel !== "string" || !relocatedLabel) {
    throw new Error("The pre-migration LaunchAgent definition cannot be safely inspected.");
  }
  if (relocatedLabel !== params.label) {
    throw new Error("The pre-migration LaunchAgent definition does not match the expected label.");
  }
  const command = await readLaunchAgentProgramArgumentsAtPath(params.env, params.label, plistPath, {
    ...params.options,
    timeoutMs: remainingLaunchdPlistReadTimeout(params.deadline),
  });
  remainingLaunchdPlistReadTimeout(params.deadline);
  if (command === null) {
    throw new Error("The pre-migration LaunchAgent definition cannot be safely inspected.");
  }
  return { plistPath, contents, mode: snapshot!.mode, command };
}

/** Install-only definition for a pre-boot-volume LaunchAgent that needs relocation. */
export async function readRelocatedLaunchAgentForInstall(
  env: GatewayServiceEnv,
  options?: GatewayServiceReadOptions,
  // Preserve the mutation caller's monotonic budget across its canonical probe.
  deadline = options?.timeoutMs === undefined ? undefined : performance.now() + options.timeoutMs,
): Promise<{ plistPath: string; command: GatewayServiceCommandConfig } | null> {
  remainingLaunchdPlistReadTimeout(deadline);
  const label = resolveLaunchAgentLabel(env);
  const targetPlistPath = resolveLaunchAgentPlistPath(env);
  if ((await readExistingLaunchAgentPlist(targetPlistPath)) !== null) {
    return null;
  }
  const relocated = await readRelocatedLaunchAgentPlistForInstall({
    env,
    label,
    targetPlistPath,
    options,
    deadline,
  });
  return relocated === null ? null : { plistPath: relocated.plistPath, command: relocated.command };
}

async function snapshotLaunchAgentLoadedState(
  plistContents: Buffer | null,
  serviceTarget: string,
): Promise<boolean> {
  const probe = await probeLaunchAgentState(serviceTarget);
  if (probe.state === "unknown") {
    throw new Error(
      `launchctl print could not determine whether ${serviceTarget} is loaded: ${probe.detail ?? "unknown error"}`,
    );
  }
  const loaded = probe.state !== "not-loaded";
  if (loaded && plistContents === null) {
    // launchd can retain a definition after its plist is deleted. Booting that
    // job out would destroy the only copy, so no exact rollback is possible.
    throw new Error(
      `LaunchAgent ${serviceTarget} is loaded but its plist is missing; refusing an install that cannot restore the current definition if activation fails.`,
    );
  }
  return loaded;
}

async function deactivateLaunchAgentDefinition(domain: string, plistPath: string): Promise<void> {
  for (const args of [
    ["bootout", domain, plistPath],
    ["unload", plistPath],
  ]) {
    assertGatewayServiceUpdateCurrent();
    const result = await execLaunchctl(args);
    assertGatewayServiceUpdateCurrent();
    if (result.code !== 0 && !isLaunchctlNotLoaded(result)) {
      throw new Error(
        `launchctl ${args[0]} failed during LaunchAgent install: ${formatLaunchctlResultDetail(result)}`,
      );
    }
  }
}

export async function installLaunchAgent(
  args: GatewayServiceInstallArgs,
): Promise<{ plistPath: string }> {
  const targetPlistPath = resolveLaunchAgentPlistPath(args.env);
  const label = resolveLaunchAgentLabel(args.env);
  const domain = resolveLaunchAgentGuiDomain();
  const serviceTarget = `${domain}/${label}`;
  const { publication, loaded, enabled, legacy } = await withGatewayServiceInstallationRecovery(
    async () => {
      await assertExternalLaunchAgentMutation(args.env, "install");
      const captured = args.definitionTransaction
        ? { kind: "transaction" as const, hooks: args.definitionTransaction }
        : { kind: "local" as const, files: await captureLaunchAgentInstallFiles(args.env) };
      const previous =
        captured.kind === "local"
          ? captured.files.originals.get(targetPlistPath)!.snapshot
          : await readExistingLaunchAgentPlist(targetPlistPath);
      // Transaction-owned relocation belongs to the existing backup owner. Its
      // current receipt must still reject a missing canonical definition before mutation.
      const relocated =
        captured.kind === "local"
          ? await readRelocatedLaunchAgentPlistForInstall({ env: args.env, label, targetPlistPath })
          : null;
      let wasEnabled = args.preserveAutoStart
        ? await isLaunchAgentEnabled({ env: args.env })
        : undefined;
      const wasLoaded = await snapshotLaunchAgentLoadedState(
        previous?.contents ?? relocated?.contents ?? null,
        serviceTarget,
      );
      if (
        wasEnabled === undefined &&
        wasLoaded &&
        captured.kind === "local" &&
        resolvePreCanonicalLaunchAgentPlistPath(args.env, label) !== targetPlistPath
      ) {
        wasEnabled = await isLaunchAgentEnabled({ env: args.env });
      }
      // Recovery publishes the exact former bytes at the canonical path while
      // retaining the former definition. Identical snapshots have the same rollback
      // target; different bytes or policy still leave the loaded owner ambiguous.
      if (
        wasLoaded &&
        previous !== null &&
        relocated !== null &&
        (!previous.contents.equals(relocated.contents) || previous.mode !== relocated.mode)
      ) {
        throw new Error(
          `LaunchAgent ${label} has multiple prior definitions; refusing an install that cannot identify the loaded definition for rollback.`,
        );
      }
      return {
        publication: captured,
        loaded: previous ? wasLoaded : false,
        enabled: wasEnabled,
        legacy: relocated ? { ...relocated, loaded: wasLoaded && !previous } : null,
      };
    },
    async () => false,
  );
  let activationAttempted = false;
  let recovery: { file: string; state: LaunchAgentRecoveryState } | undefined;
  const install = async () => {
    if (legacy?.loaded && publication.kind === "local") {
      const file = `${targetPlistPath}.reconcile-${randomUUID()}.bak`;
      const state = await preserveLaunchAgentRecoveryDefinition({
        env: args.env,
        file,
        contents: legacy.contents,
        mode: legacy.mode,
        assertCurrent: publication.files.assertCurrent,
      });
      recovery = { file, state };
    }
    const published = await writeLaunchAgentPlist(
      args,
      publication.kind === "local" ? publication.files : undefined,
    );
    await (publication.kind === "local"
      ? publication.files.assertCurrent()
      : publication.hooks.beforeWrite());
    // Recheck immediately before activation; another supervisor can appear during publication.
    await assertNoSystemLaunchDaemonOwnership(label);
    if (recovery && publication.kind === "local") {
      await verifyLaunchAgentRecoveryDefinition({
        ...recovery,
        assertCurrent: publication.files.assertCurrent,
      });
    }
    assertGatewayServiceUpdateCurrent();
    activationAttempted = true;
    if (legacy?.loaded) {
      await deactivateLaunchAgentDefinition(domain, legacy.plistPath);
    }
    if (loaded) {
      await deactivateLaunchAgentDefinition(domain, published.plistPath);
    }
    await bootstrapLaunchAgentOrThrow({
      domain,
      serviceTarget,
      plistPath: published.plistPath,
      actionHint: "openclaw gateway install --force",
      retryPendingTeardown: true,
      assertCurrent: assertGatewayServiceUpdateCurrent,
      preserveAutoStart: args.preserveAutoStart,
      preservedEnabled: enabled,
    });
    if (publication.kind === "local") {
      // Keep registration in the account's real home: explicit bootstrap alone
      // does not make the boot-volume copy discoverable at the next login.
      await publication.files.publishRegistration();
    }
    assertGatewayServiceUpdateCurrent();
    return published;
  };
  const { plistPath, stdoutPath } =
    publication.kind === "transaction"
      ? await install()
      : await withGatewayServiceInstallationRecovery(install, async () => {
          const files = publication.files;
          if (activationAttempted) {
            await files.assertCurrent();
            const current = await probeLaunchAgentState(serviceTarget);
            if (current.state === "unknown") {
              throw new Error(
                `launchctl print could not determine whether ${serviceTarget} is loaded during LaunchAgent rollback: ${current.detail ?? "unknown error"}`,
              );
            }
            if (current.state !== "not-loaded") {
              await files.assertCurrent();
              const bootout = await execLaunchctl(["bootout", serviceTarget]);
              if (bootout.code !== 0 && !isLaunchctlNotLoaded(bootout)) {
                throw new Error(
                  `launchctl bootout failed: ${formatLaunchctlResultDetail(bootout)}`,
                );
              }
            }
          }
          const restored = await files.restore();
          if (activationAttempted && (loaded || legacy?.loaded)) {
            if (recovery) {
              const contents = await verifyLaunchAgentRecoveryDefinition({
                ...recovery,
                assertCurrent: files.assertCurrent,
              });
              await publishServiceFile({
                filePath: targetPlistPath,
                contents,
                mode: recovery.state.mode,
                definitionTransaction: files.hooks,
              });
            }
            await files.assertCurrent();
            await assertNoSystemLaunchDaemonOwnership(label);
            await bootstrapLaunchAgentOrThrow({
              domain,
              serviceTarget,
              plistPath: targetPlistPath,
              actionHint: "openclaw gateway start",
              retryPendingTeardown: true,
              assertCurrent: assertGatewayServiceUpdateCurrent,
              preserveAutoStart: args.preserveAutoStart || enabled !== undefined,
              preservedEnabled: enabled,
            });
          }
          return restored || activationAttempted;
        });
  // `bootstrap` already loads RunAtLoad agents. Avoid `kickstart -k` here:
  // on slow macOS guests it SIGTERMs the freshly booted gateway and pushes the
  // real listener startup past setup's health deadline.
  writeFormattedLines(
    args.stdout,
    [
      { label: "Installed LaunchAgent", value: plistPath },
      { label: "Logs", value: stdoutPath },
    ],
    { leadingBlankLine: true },
  );
  return { plistPath };
}
