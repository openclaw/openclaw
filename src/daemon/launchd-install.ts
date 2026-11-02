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
  isLaunchAgentEnabled,
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
    await bootoutLaunchAgent(`${domain}/${label}`);
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
async function assertExternalLaunchAgentMutation(
  env: Record<string, string | undefined>,
  action: "install" | "uninstall",
): Promise<void> {
  const configuredCurrentLabel = process.env.OPENCLAW_LAUNCHD_LABEL?.trim();
  const candidates = new Set([
    resolveLaunchAgentLabel(env),
    ...(configuredCurrentLabel ? [assertValidLaunchAgentLabel(configuredCurrentLabel)] : []),
  ]);
  for (const label of candidates) {
    if (await isCurrentProcessInsideLaunchdService(label)) {
      throw new Error(
        `Refusing to ${action} LaunchAgent ${resolveLaunchAgentLabel(env)} from inside ${label}; run this command from an external shell.`,
      );
    }
  }
}

export async function stageLaunchAgent(
  args: GatewayServiceInstallArgs,
): Promise<{ plistPath: string }> {
  const { plistPath, stdoutPath } = await writeLaunchAgentPlist(args);
  writeFormattedLines(args.stdout, [
    { label: "Staged LaunchAgent", value: plistPath },
    { label: "Logs", value: stdoutPath },
  ]);
  return { plistPath };
}

async function bootoutLaunchAgent(serviceTarget: string): Promise<void> {
  assertGatewayServiceUpdateCurrent();
  const result = await execLaunchctl(["bootout", serviceTarget]);
  assertGatewayServiceUpdateCurrent();
  if (result.code !== 0 && !isLaunchctlNotLoaded(result)) {
    throw new Error(`launchctl bootout failed: ${formatLaunchctlResultDetail(result)}`);
  }
}

export async function installLaunchAgent(
  args: GatewayServiceInstallArgs,
): Promise<{ plistPath: string }> {
  const targetPlistPath = resolveLaunchAgentPlistPath(args.env);
  const label = resolveLaunchAgentLabel(args.env);
  const domain = resolveLaunchAgentGuiDomain();
  const serviceTarget = `${domain}/${label}`;
  const { publication, loaded, restoreLoaded, enabled } =
    await withGatewayServiceInstallationRecovery(
      async () => {
        await assertExternalLaunchAgentMutation(args.env, "install");
        const captured = args.definitionTransaction
          ? { kind: "transaction" as const, hooks: args.definitionTransaction }
          : { kind: "local" as const, files: await captureLaunchAgentInstallFiles(args.env) };
        const previous =
          captured.kind === "local"
            ? captured.files.originals.get(targetPlistPath)!.snapshot
            : await readExistingLaunchAgentPlist(targetPlistPath);
        const wasEnabled = args.preserveAutoStart
          ? await isLaunchAgentEnabled({ env: args.env })
          : undefined;
        const probe = await probeLaunchAgentState(serviceTarget);
        if (probe.state === "unknown") {
          throw new Error(
            `launchctl print could not determine whether ${serviceTarget} is loaded: ${probe.detail ?? "unknown error"}`,
          );
        }
        const wasLoaded = probe.state !== "not-loaded";
        const wasRestorable = wasLoaded && previous !== null;
        if (wasLoaded && !wasRestorable) {
          args.warn?.(
            `LaunchAgent ${serviceTarget} plist is missing; replacing the registration without a previous definition to restore.`,
          );
        }
        return {
          publication: captured,
          loaded: wasLoaded,
          restoreLoaded: wasRestorable,
          enabled: wasEnabled,
        };
      },
      async () => false,
    );
  const bootstrap = (plistPath: string, actionHint: string) =>
    bootstrapLaunchAgentOrThrow({
      domain,
      serviceTarget,
      plistPath,
      actionHint,
      retryPendingTeardown: true,
      assertCurrent: assertGatewayServiceUpdateCurrent,
      preserveAutoStart: args.preserveAutoStart,
      preservedEnabled: enabled,
    });
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
      await bootoutLaunchAgent(serviceTarget);
    }
    await bootstrap(published.plistPath, "openclaw gateway install --force");
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
              await bootoutLaunchAgent(serviceTarget);
            }
          }
          const restored = await files.restore();
          if (activationAttempted && restoreLoaded) {
            await files.assertCurrent();
            await assertNoSystemLaunchDaemonOwnership(label);
            await bootstrap(targetPlistPath, "openclaw gateway start");
          }
          return restored || activationAttempted;
        });
  // `bootstrap` already loads RunAtLoad agents. Avoid `kickstart -k` here:
  // on slow macOS guests it SIGTERMs the freshly booted gateway and pushes the
  // real listener startup past setup's health deadline.
  writeFormattedLines(args.stdout, [
    { label: "Installed LaunchAgent", value: plistPath },
    { label: "Logs", value: stdoutPath },
  ]);
  return { plistPath };
}
