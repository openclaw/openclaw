import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, relative as relativePath, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { mapNestedStrings } from "../shared/map-nested-strings.js";
import type { ClawHubCoordinate } from "./clawhub-source.js";
import { digestTemplateBytes, digestTemplateValue } from "./digest.js";
import { readTemplateManifestFile } from "./reader.js";
import { MAX_MANAGED_FILE_BYTES } from "./source-limits.js";
import type { TemplateAddPlan } from "./types.js";

export async function workspaceIdentity(
  workspace: string,
  additions: Readonly<Record<string, string | null>> = {},
): Promise<string> {
  const entries: string[] = [];
  const source = await fsSafeRoot(workspace);
  const inspect = async (relative: string): Promise<void> => {
    const stat = await lstat(resolve(workspace, relative));
    if (stat.isSymbolicLink()) {
      throw new Error("Workspace path became a symlink: " + relative);
    }
    const planned = Object.hasOwn(additions, relative);
    const addition = additions[relative];
    // Directory clocks change during owned writes/rollback, not its incarnation.
    if (!planned) {
      entries.push(relative + ":" + stat.dev + ":" + stat.ino + ":" + stat.mode);
    }
    if (stat.isFile()) {
      const read = await source.read(relative, {
        hardlinks: "reject",
        maxBytes: MAX_MANAGED_FILE_BYTES,
        symlinks: "reject",
      });
      const digest = digestTemplateBytes(read.buffer);
      if (planned) {
        if (typeof addition !== "string" || digest !== addition) {
          throw new Error("Pending Template instruction changed: " + relative);
        }
      } else {
        entries.push(stat.size + ":" + stat.mtimeMs + ":" + stat.ctimeMs, digest);
      }
    } else if (stat.isDirectory()) {
      if (planned && addition !== null) {
        throw new Error("Pending Template instruction became a directory: " + relative);
      }
      for (const name of (await readdir(resolve(workspace, relative))).toSorted()) {
        await inspect(relative ? relative + "/" + name : name);
      }
    } else {
      throw new Error("Workspace path is not a regular file or directory: " + relative);
    }
  };
  await inspect("");
  return digestTemplateValue(entries);
}

export function configuredPlanDigest(plan: TemplateAddPlan): string {
  const { planIntegrity: _planIntegrity, ...content } = plan;
  const sourceRoot = resolve(plan.template.packageRoot);
  return digestTemplateValue(
    mapNestedStrings(content, (value) => {
      if (!isAbsolute(value)) {
        return value;
      }
      const child = relativePath(sourceRoot, resolve(value));
      return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
        ? `$TEMPLATE_SOURCE/${child.split(sep).join("/")}`
        : value;
    }),
  );
}

export async function configuredSourceIntegrity(plan: TemplateAddPlan): Promise<string> {
  const source = await readTemplateManifestFile(
    plan.template.kind === "package" ? plan.template.packageRoot : plan.template.manifestPath,
  );
  if (
    !source.ok ||
    source.source.name !== plan.template.name ||
    source.source.version !== plan.template.version ||
    (plan.template.integrityKind === "development-snapshot" &&
      source.source.integrity !== plan.template.integrity)
  ) {
    throw new Error("Template source changed after consent.");
  }
  for (const action of plan.actions) {
    if (action.kind !== "workspaceFile" && action.kind !== "bootstrap") {
      continue;
    }
    const digest =
      action.sourceKind === "templateMarkdownBody" && source.templateMarkdownBody
        ? digestTemplateBytes(source.templateMarkdownBody)
        : [
            ...source.snapshot.workspaceSources,
            ...(source.packageBootstrap ? [source.packageBootstrap] : []),
          ].find((file) => file.realPath === action.source)?.digest;
    if (!digest || digest !== action.digest) {
      throw new Error("Template source changed after consent.");
    }
  }
  // Reader integrity binds development consent to its exact source path. The
  // retained checkpoint instead compares bytes across verified extraction roots.
  const withoutRealPath = ({
    realPath: _realPath,
    ...file
  }: NonNullable<typeof source.packageBootstrap>) => file;
  return digestTemplateValue({
    ...source.snapshot,
    workspaceSources: source.snapshot.workspaceSources.map(withoutRealPath),
    ...(source.snapshot.packageBootstrap
      ? { packageBootstrap: withoutRealPath(source.snapshot.packageBootstrap) }
      : {}),
  });
}

export async function readRetainedTemplateInitialization(
  config: OpenClawConfig,
  agentId: string,
  workspace: string,
  source: ClawHubCoordinate,
  assertCurrent: () => void,
) {
  const sessionKey = resolveAgentMainSessionKey({ cfg: config, agentId });
  const pending = await readSessionEntryReadOnlyInWorker(
    {
      agentId,
      sessionKey,
      storePath: resolveSessionStorePathCore(config.session?.store, { agentId }),
    },
    assertCurrent,
  );
  const continuation = pending?.templateInitialization;
  const actualConfig = config.agents?.entries?.[agentId];
  const preparing = continuation?.preparing;
  const admissionMatches = isDeepStrictEqual(continuation?.agentConfig, actualConfig);
  const intentMatches = preparing && isDeepStrictEqual(preparing.agentConfig, actualConfig);
  if (
    !pending?.initializationPending ||
    !continuation ||
    !isDeepStrictEqual(continuation.source, source) ||
    (!admissionMatches && !intentMatches) ||
    (await workspaceIdentity(workspace, preparing?.workspaceAdditions)) !==
      continuation.workspaceIdentity
  ) {
    throw new Error(
      "The requested agent already exists and has no matching retained Template initialization",
    );
  }
  let configured = continuation.configured;
  if (intentMatches) {
    const root = await fsSafeRoot(workspace);
    const complete = (
      await Promise.all(Object.keys(preparing.workspaceAdditions).map((path) => root.exists(path)))
    ).every(Boolean);
    if (complete) {
      configured = { planDigest: preparing.planDigest, sourceIntegrity: preparing.sourceIntegrity };
    } else if (!admissionMatches) {
      throw new Error("Configured Template instructions disappeared before recovery");
    }
  }
  return {
    sessionKey,
    continuation,
    configured,
    workspaceIdentity: await workspaceIdentity(workspace),
  };
}
