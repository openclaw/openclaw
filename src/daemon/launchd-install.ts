/** Transactional LaunchAgent installation, staging, rollback, and removal. */
import fs from "node:fs/promises";
import path from "node:path";
import { isCurrentProcessInsideLaunchdService } from "./launchd-current-service.js";
import {
  execLaunchctl,
  formatLaunchctlResultDetail,
  isLaunchctlNotLoaded,
} from "./launchd-exec.js";
import { assertValidLaunchAgentLabel, resolveLaunchAgentLabel } from "./launchd-label.js";
import {
  bootstrapLaunchAgentOrThrow,
  probeLaunchAgentState,
  resolveLaunchAgentGuiDomain,
} from "./launchd-runtime.js";
import {
  captureLaunchAgentInstallFiles,
  readExistingLaunchAgentPlist,
  resolveLaunchAgentPlistPath,
  writeLaunchAgentPlist,
} from "./launchd-service-files.js";
import { assertNoSystemLaunchDaemonOwnership } from "./launchd-system.js";
import { formatLine, normalizeWindowsPathSeparators, writeFormattedLines } from "./output.js";
import { resolveDaemonHomeDir } from "./paths.js";
import type { GatewayServiceInstallArgs, GatewayServiceManageArgs } from "./service-types.js";
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
  const plistPath = resolveLaunchAgentPlistPath(env);
  const probe = await probeLaunchAgentState(`${domain}/${label}`);
  if (probe.state !== "not-loaded") {
    const bootout = await execLaunchctl(["bootout", domain, plistPath]);
    if (bootout.code !== 0 && !isLaunchctlNotLoaded(bootout)) {
      throw new Error(`launchctl bootout failed: ${formatLaunchctlResultDetail(bootout)}`);
    }
  }

  try {
    await fs.lstat(plistPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw createLaunchAgentRemovalError(error);
    }
    stdout.write(`LaunchAgent not found at ${plistPath}\n`);
    return;
  }

  const home = normalizeWindowsPathSeparators(resolveDaemonHomeDir(env));
  const trashDir = path.posix.join(home, ".Trash");
  const dest = path.join(trashDir, `${label}.plist`);
  try {
    await fs.mkdir(trashDir, { recursive: true });
    await fs.rename(plistPath, dest);
    stdout.write(`${formatLine("Moved LaunchAgent to Trash", dest)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        await fs.lstat(plistPath);
      } catch (accessError) {
        if ((accessError as NodeJS.ErrnoException).code === "ENOENT") {
          stdout.write(`LaunchAgent not found at ${plistPath}\n`);
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
    if (await isCurrentProcessInsideLaunchdService(label, process.env)) {
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
  if (args.beforeLoad) {
    throw new Error("Deferred native service load is not supported on this platform.");
  }
  const targetPlistPath = resolveLaunchAgentPlistPath(args.env);
  const label = resolveLaunchAgentLabel(args.env);
  const domain = resolveLaunchAgentGuiDomain();
  const serviceTarget = `${domain}/${label}`;
  const { publication, loaded } = await withGatewayServiceInstallationRecovery(
    async () => {
      await assertExternalLaunchAgentMutation(args.env, "install");
      const captured = args.definitionTransaction
        ? { kind: "transaction" as const, hooks: args.definitionTransaction }
        : { kind: "local" as const, files: await captureLaunchAgentInstallFiles(args.env) };
      const previous =
        captured.kind === "local"
          ? captured.files.originals.get(targetPlistPath)!.snapshot
          : await readExistingLaunchAgentPlist(targetPlistPath);
      const wasLoaded = await snapshotLaunchAgentLoadedState(
        previous?.contents ?? null,
        serviceTarget,
      );
      return { publication: captured, loaded: wasLoaded };
    },
    async () => false,
  );
  let activationAttempted = false;
  const install = async () => {
    const published = await writeLaunchAgentPlist(
      args,
      publication.kind === "local" ? publication.files : undefined,
    );
    await (publication.kind === "local"
      ? publication.files.assertCurrent()
      : publication.hooks.beforeWrite());
    // Recheck immediately before activation; another supervisor can appear during publication.
    await assertNoSystemLaunchDaemonOwnership(label);
    assertGatewayServiceUpdateCurrent();
    activationAttempted = true;
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
    });
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
          if (activationAttempted && loaded) {
            await files.assertCurrent();
            await assertNoSystemLaunchDaemonOwnership(label);
            await bootstrapLaunchAgentOrThrow({
              domain,
              serviceTarget,
              plistPath: targetPlistPath,
              actionHint: "openclaw gateway start",
              retryPendingTeardown: true,
              assertCurrent: assertGatewayServiceUpdateCurrent,
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
