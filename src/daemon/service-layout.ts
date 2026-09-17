/** Summarizes installed service command paths and OpenClaw package layout. */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { pathExists } from "../infra/fs-safe.js";
import { readPackageName, readPackageVersion } from "../infra/package-json.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

/** Summary of the installed gateway service command and package layout. */
export type GatewayServiceLayoutSummary = {
  execStart: string;
  sourcePath?: string;
  sourcePathReal?: string;
  sourceScope?: "user" | "system";
  entrypoint?: string;
  entrypointReal?: string;
  packageRoot?: string;
  packageRootReal?: string;
  packageVersion?: string;
  entrypointSourceCheckout?: boolean;
};

/** Local package evidence remains available when the Gateway cannot answer a probe. */
export async function inspectGatewayServiceInstallationDrift(
  layout: Pick<GatewayServiceLayoutSummary, "packageRootReal" | "packageVersion"> | undefined,
  activeRoot: string,
): Promise<string | undefined> {
  const serviceRoot = layout?.packageRootReal;
  const activeRootReal = await tryRealpath(activeRoot);
  if (!serviceRoot || !activeRootReal || serviceRoot === activeRootReal) {
    return undefined;
  }
  const [serviceStat, activeStat] = await Promise.all(
    [serviceRoot, activeRootReal].map((root) => fs.stat(root).catch(() => undefined)),
  );
  // A deployment can expose the same package through two bind mounts.
  if (
    serviceStat &&
    activeStat &&
    serviceStat.dev === activeStat.dev &&
    serviceStat.ino === activeStat.ino
  ) {
    return undefined;
  }
  const activeVersion = (await readPackageVersion(activeRootReal)) ?? undefined;
  const serviceVersion =
    layout.packageVersion ?? (await readPackageVersion(serviceRoot)) ?? undefined;
  return `Gateway service targets a different OpenClaw install: ${serviceRoot} (${serviceVersion ?? "version unknown"}); active CLI: ${activeRootReal} (${activeVersion ?? "version unknown"}). Run \`openclaw doctor --fix\` or \`openclaw gateway install --force\` from the active CLI.`;
}

function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatExecStart(programArguments: readonly string[]): string {
  return programArguments.map(shellQuoteArg).join(" ");
}

function resolveSystemdScopeFromServicePath(
  sourcePath: string | undefined,
): "user" | "system" | undefined {
  const normalized = sourcePath?.replaceAll("\\", "/") ?? "";
  if (!normalized.endsWith(".service")) {
    return undefined;
  }
  if (
    normalized.startsWith("/etc/systemd/") ||
    normalized.startsWith("/usr/lib/systemd/") ||
    normalized.startsWith("/lib/systemd/")
  ) {
    return "system";
  }
  return "user";
}

export function resolveServiceEntrypointIndex(
  programArguments: readonly string[],
): number | undefined {
  // Managed commands put the entrypoint immediately before the subcommand.
  // A subcommand name following a native option is its value, not this boundary.
  const commandIndex = programArguments.findIndex(
    (arg, index, args) =>
      index > 0 &&
      !args[index - 1]?.startsWith("-") &&
      (arg === "gateway" || (arg === "node" && args[index + 1] === "run")),
  );
  return commandIndex > 0 ? commandIndex - 1 : undefined;
}

export function resolveServiceEntrypoint(
  command: Pick<GatewayServiceCommandConfig, "programArguments" | "workingDirectory">,
): string | undefined {
  const entrypointIndex = resolveServiceEntrypointIndex(command.programArguments);
  if (entrypointIndex === undefined) {
    return undefined;
  }
  const entrypoint = command.programArguments[entrypointIndex];
  if (!entrypoint) {
    return undefined;
  }
  if (path.isAbsolute(entrypoint) || path.win32.isAbsolute(entrypoint)) {
    return entrypoint;
  }
  // Service managers resolve relative commands against their configured
  // working directory; without an absolute base, ownership is ambiguous.
  const workingDirectory = command.workingDirectory?.trim();
  if (!workingDirectory) {
    return undefined;
  }
  if (path.isAbsolute(workingDirectory)) {
    return path.resolve(workingDirectory, entrypoint);
  }
  if (path.win32.isAbsolute(workingDirectory)) {
    return path.win32.resolve(workingDirectory, entrypoint);
  }
  return undefined;
}

function tryRealpath(value: string): Promise<string>;
function tryRealpath(value: string | undefined): Promise<string | undefined>;
async function tryRealpath(value: string | undefined): Promise<string | undefined> {
  if (!value) {
    return undefined;
  }
  const resolved = path.resolve(value);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

export async function isSourceCheckoutRoot(candidate: string): Promise<boolean> {
  const hasRepoMarker =
    (await pathExists(path.join(candidate, ".git"))) ||
    (await pathExists(path.join(candidate, "pnpm-workspace.yaml")));
  if (!hasRepoMarker) {
    return false;
  }
  return (
    (await pathExists(path.join(candidate, "src"))) &&
    (await pathExists(path.join(candidate, "extensions")))
  );
}

async function resolveOpenClawPackageRoot(entrypoint: string): Promise<string | undefined> {
  let current = path.dirname(path.resolve(entrypoint));
  // Installed dist entrypoints can sit several levels below package root in
  // pnpm layouts; bound the walk to avoid scanning arbitrary filesystem depth.
  for (let depth = 0; depth < 8; depth += 1) {
    const packageJson = path.join(current, "package.json");
    if (await pathExists(packageJson)) {
      const name = await readPackageName(current);
      if (name === "openclaw") {
        return current;
      }
    }
    const next = path.dirname(current);
    if (next === current) {
      return undefined;
    }
    current = next;
  }
  return undefined;
}

export async function summarizeGatewayServiceLayout(
  command: Pick<
    GatewayServiceCommandConfig,
    "programArguments" | "workingDirectory" | "sourcePath"
  > | null,
): Promise<GatewayServiceLayoutSummary | undefined> {
  if (!command) {
    return undefined;
  }
  const sourcePath = command.sourcePath?.trim() || undefined;
  const entrypoint = resolveServiceEntrypoint(command);
  const [sourcePathReal, entrypointReal] = await Promise.all([
    tryRealpath(sourcePath),
    tryRealpath(entrypoint),
  ]);
  const packageRoot = entrypointReal ? await resolveOpenClawPackageRoot(entrypointReal) : undefined;
  const packageRootReal = await tryRealpath(packageRoot);
  const packageVersion = packageRoot
    ? ((await readPackageVersion(packageRoot)) ?? undefined)
    : undefined;
  const entrypointSourceCheckout = packageRootReal
    ? await isSourceCheckoutRoot(packageRootReal)
    : undefined;

  return {
    execStart: formatExecStart(command.programArguments),
    ...(sourcePath ? { sourcePath } : {}),
    ...(sourcePathReal ? { sourcePathReal } : {}),
    ...(sourcePath ? { sourceScope: resolveSystemdScopeFromServicePath(sourcePath) } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    ...(entrypointReal ? { entrypointReal } : {}),
    ...(packageRoot ? { packageRoot } : {}),
    ...(packageRootReal ? { packageRootReal } : {}),
    ...(packageVersion ? { packageVersion } : {}),
    ...(entrypointSourceCheckout !== undefined ? { entrypointSourceCheckout } : {}),
  };
}

/** Compare an already inspected launcher with one installation; no service discovery or effects. */
export async function gatewayServiceCommandMatchesRoot(
  root: string | undefined,
  command: GatewayServiceCommandConfig | null,
): Promise<boolean | null> {
  const expectedRoot = normalizeOptionalString(root);
  if (!expectedRoot) {
    return null;
  }
  const layout = await summarizeGatewayServiceLayout(command);
  const serviceRoot = layout?.packageRoot;
  const serviceEntrypoint = layout?.entrypoint;
  if (
    !serviceRoot ||
    !serviceEntrypoint ||
    (!path.isAbsolute(serviceEntrypoint) && !path.win32.isAbsolute(serviceEntrypoint))
  ) {
    return null;
  }
  const [expectedRootReal, serviceRootReal] = await Promise.all([
    tryRealpath(expectedRoot),
    tryRealpath(serviceRoot),
  ]);
  if (expectedRootReal === serviceRootReal) {
    return true;
  }
  // Paired read-only release mounts have different paths but the same directory
  // identity. Copies of another release must remain foreign.
  const [expected, actual] = await Promise.all(
    [expectedRootReal, serviceRootReal].map((directory) => fs.stat(directory).catch(() => null)),
  );
  if (expected && actual && expected.dev === actual.dev && expected.ino === actual.ino) {
    return true;
  }
  const managed = command?.managedDefinition;
  if (!managed || (await gatewayServiceCommandMatchesRoot(expectedRoot, managed)) !== true) {
    return false;
  }
  const namespace = path.dirname(expectedRootReal);
  const managedLayout = await summarizeGatewayServiceLayout(managed);
  const stableEntry = path.join(
    namespace,
    "current",
    "dist",
    path.basename(managedLayout?.entrypoint ?? ""),
  );
  if (serviceEntrypoint !== stableEntry) {
    return false;
  }
  // Deployment-owned current points into this installation's releases, either
  // by symlink or by a paired bind mount. Unrelated namespaces remain foreign.
  const releases = path.join(namespace, "releases");
  if (serviceRootReal.startsWith(`${releases}${path.sep}`)) {
    return true;
  }
  try {
    for await (const entry of await fs.opendir(releases)) {
      const candidate = await fs.lstat(path.join(releases, entry.name));
      if (actual && candidate.dev === actual.dev && candidate.ino === actual.ino) {
        return true;
      }
    }
  } catch {
    // Without directory identity proof, the override cannot authorize lifecycle actions.
  }
  return false;
}
