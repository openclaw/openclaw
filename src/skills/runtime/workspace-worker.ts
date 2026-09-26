import fs from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { createFileWatchNotifier } from "../../infra/file-watch-notifier.js";
import type { applyExtractedSkillRoot } from "../lifecycle/archive-install.js";
import type * as Status from "../lifecycle/clawhub-status.js";
import type * as Store from "../lifecycle/clawhub-store.js";
import type * as Uninstall from "../lifecycle/clawhub-uninstall.js";
import { normalizeWorkspaceSkillRoots } from "../loading/workspace-skill-roots.js";
import type { WorkspaceSkillSourceRequest } from "../loading/workspace-skill-sources.js";
import {
  decodeSkillWorkerRequest,
  skillWorkerLines,
  writeSkillWorkerResult,
} from "./workspace-worker-io.js";

type ApplyRequest = Omit<
  Parameters<typeof applyExtractedSkillRoot>[0],
  "workspaceDir" | "logger" | "beforeInstall"
>;
type RemovalRequest = { plan: Uninstall.ClawHubSkillUninstallPlan; reportChange?: boolean };
type Decision = { decision: null | { error: string; failureKind?: unknown } };
type WatchRequest = Pick<WorkspaceSkillSourceRequest, "sourcePlan" | "executionWorkspaceDir">;
type HostRequest<T> = Omit<T, "workspaceDir">;

/** A dedicated subprocess reuses native Skills owners on either kind of workspace host. */
export async function serveWorkspaceSkills(options: {
  workspace: string;
  home: string;
  operation: string;
  input: Readable;
  output: Writable;
}): Promise<void> {
  const { workspace, home, operation, input, output } = options;
  const write = (value: unknown) => writeSkillWorkerResult(output, value);
  if (operation === "applyRoot") {
    const { applyExtractedSkillRoot } = await import("../lifecycle/archive-install.js");
    const lines = skillWorkerLines(input);
    try {
      // SAFETY: The provisioned publisher sends ApplyRequest; the upload root is checked below.
      const request = (await lines.read()) as ApplyRequest;
      if (
        typeof request.extractedRoot !== "string" ||
        path.dirname(request.extractedRoot) !== path.join(home, ".cache/openclaw/skill-installs")
      ) {
        throw new Error("Skill source is outside the upload directory");
      }
      const result = await applyExtractedSkillRoot({
        ...request,
        workspaceDir: workspace,
        logger: { info: console.error, warn: console.error },
        beforeInstall: async (mode) => {
          await write({ type: "prepared", mode });
          // SAFETY: The Gateway policy reply is checked for null or a valid error decision below.
          const reply = (await lines.read()) as Decision;
          if (reply.decision === null) {
            return undefined;
          }
          if (
            typeof reply.decision?.error !== "string" ||
            (reply.decision.failureKind !== "invalid-request" &&
              reply.decision.failureKind !== "unavailable")
          ) {
            throw new Error("Invalid Gateway skill policy decision");
          }
          return { error: reply.decision.error, failureKind: reply.decision.failureKind };
        },
      });
      await write({ type: "result", result });
    } finally {
      lines.close();
    }
    return;
  }
  if (operation === "removeSkill") {
    const { applyClawHubSkillUninstall } = await import("../lifecycle/clawhub-uninstall.js");
    const { resolveWorkspaceSkillInstallDir } = await import("../lifecycle/install-paths.js");
    const lines = skillWorkerLines(input);
    try {
      // SAFETY: The publisher sends its native uninstall plan; the target is checked below.
      const request = (await lines.read()) as RemovalRequest;
      if (
        request.plan?.targetDir !== resolveWorkspaceSkillInstallDir(workspace, request.plan?.slug)
      ) {
        throw new Error("Skill removal is outside the provisioned workspace");
      }
      const checkpoint = async (phase: string, event?: unknown) => {
        await write({ type: "prepared", phase, event });
        // SAFETY: The Gateway checkpoint reply is checked for null or an error string below.
        const reply = (await lines.read()) as Decision;
        if (reply.decision === null) {
          return;
        }
        if (typeof reply.decision?.error !== "string") {
          throw new Error("Invalid Gateway removal decision");
        }
        throw new Error(reply.decision.error);
      };
      const assertConnected = () => {
        if (input.destroyed || input.readableEnded) {
          throw new Error("Skill removal transport closed");
        }
      };
      const result = await applyClawHubSkillUninstall(
        { ...request.plan, workspaceDir: workspace },
        {
          beforePersistentApply: assertConnected,
          beforeRollback: assertConnected,
          authorizeMutation: (phase) => checkpoint(phase),
          ...(request.reportChange
            ? {
                onCommittedChange: (event: unknown) => checkpoint("committed", event),
              }
            : {}),
        },
      );
      await write({ type: "result", result });
    } finally {
      lines.close();
    }
    return;
  }
  if (operation === "watch") {
    const {
      ensureSkillsWatcher,
      reconcileSkillsWatcherCoverage,
      closeSkillsWatchers,
      registerSkillsChangeListener,
    } = await import("./refresh.js");
    const lines = skillWorkerLines(input);
    let stopped = false;
    let queued = false;
    let unavailable = false;
    let unsubscribe: (() => void) | undefined;
    let retiring: Promise<void> | undefined;
    let outputClosing: Promise<void> | undefined;
    let notifier: ReturnType<typeof createFileWatchNotifier> | undefined;
    const retire = () => {
      stopped = true;
      unsubscribe?.();
      retiring ??= closeSkillsWatchers();
      outputClosing ??= notifier?.close();
      void retiring.catch(() => {});
      void outputClosing?.catch(() => {});
      lines.close();
    };
    notifier = createFileWatchNotifier(output, retire);
    const errors: unknown[] = [];
    try {
      // SAFETY: The same-version watch adapter sends this contract; workspace identity is checked next.
      const request = (await lines.read()) as WatchRequest;
      if (stopped) {
        throw new Error("Skills watch transport closed before admission");
      }
      assertWorkspace(request, workspace);
      const { executionWorkspaceDir } = normalizeWorkspaceSkillRoots({
        agentWorkspaceDir: workspace,
        executionWorkspaceDir: request.executionWorkspaceDir,
      });
      const params = { ...request, workspaceDir: workspace, executionWorkspaceDir };
      unsubscribe = registerSkillsChangeListener((event) => {
        if (stopped || event.workspaceDir !== workspace) {
          return;
        }
        if (event.reason === "watch-unavailable") {
          unavailable = true;
        }
        const recovered = event.reason === "watch-available";
        if (recovered) {
          if (event.sourceScope?.executionWorkspaceDir !== params.executionWorkspaceDir) {
            return;
          }
          // Fresh scans can reveal a symlink or nested root while normal watch
          // discovery is suppressed. Verify those new targets before clearing
          // the host's fallback, and let their ready event retry this check.
          if (!reconcileSkillsWatcherCoverage(params)) {
            return;
          }
          unavailable = false;
        }
        notifier?.send(
          recovered ? "available" : event.reason === "watch-unavailable" ? "unavailable" : "change",
        );
        // Native events also invalidate discovery targets (for example a new symlink).
        if (event.reason === "watch" && !queued && !unavailable) {
          queued = true;
          queueMicrotask(() => {
            queued = false;
            if (!stopped && !unavailable) {
              ensureSkillsWatcher(params);
            }
          });
        }
      });
      ensureSkillsWatcher(params);
      try {
        await lines.read();
        throw new Error("Unexpected message on the skill watch subscription");
      } catch (error) {
        if (!input.readableEnded && !input.destroyed) {
          throw error;
        }
      }
    } catch (error) {
      errors.push(error);
    } finally {
      retire();
      const results = await Promise.allSettled([retiring, outputClosing]);
      errors.push(
        ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      );
      notifier = undefined;
    }
    if (errors.length) {
      throw new AggregateError(errors, "Skills watch retirement failed");
    }
    return;
  }

  const chunks: Buffer[] = [];
  const inputChunks: AsyncIterable<unknown> = input;
  for await (const raw of inputChunks) {
    if (typeof raw === "string") {
      chunks.push(Buffer.from(raw));
    } else if (raw instanceof Uint8Array) {
      chunks.push(Buffer.from(raw));
    } else {
      throw new Error("Skill worker input must be bytes");
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const decoded = decodeSkillWorkerRequest(text);
  if (operation === "installDependencies") {
    const { installSkillDependencies } = await import("../lifecycle/install.js");
    await write(
      // SAFETY: The Gateway adapter serializes the approved native dependency recipe for this operation.
      await installSkillDependencies(decoded as Parameters<typeof installSkillDependencies>[0]),
    );
    return;
  }
  // These operations retain native error envelopes used by the Gateway callers.
  if (operation.startsWith("clawhub")) {
    const store = await import("../lifecycle/clawhub-store.js");
    const status = await import("../lifecycle/clawhub-status.js");
    const uninstall = await import("../lifecycle/clawhub-uninstall.js");
    try {
      let result: unknown;
      switch (operation) {
        case "clawhubPlanRemoval":
          result = await uninstall.planClawHubSkillUninstall({
            // SAFETY: The paired adapter sends native plan arguments; the host supplies workspaceDir.
            ...(decoded as HostRequest<Parameters<typeof Uninstall.planClawHubSkillUninstall>[0]>),
            workspaceDir: workspace,
          });
          break;
        case "clawhubVerifyTarget":
          result = await status.resolveClawHubSkillVerificationTarget({
            // SAFETY: The paired adapter sends native verification arguments; workspaceDir is host-owned.
            ...(decoded as HostRequest<
              Parameters<typeof Status.resolveClawHubSkillVerificationTarget>[0]
            >),
            workspaceDir: workspace,
          });
          break;
        case "clawhubPreflight":
          result = await status.preflightSkillOwnerState({
            // SAFETY: The paired adapter sends native preflight arguments; workspaceDir is host-owned.
            ...(decoded as HostRequest<Parameters<typeof Status.preflightSkillOwnerState>[0]>),
            workspaceDir: workspace,
          });
          break;
        case "clawhubReadLock":
          result = await store.readClawHubSkillsLockfile(workspace);
          break;
        case "clawhubUpdateSlug":
          result = await status.resolveRequestedUpdateSlug({
            // SAFETY: The paired adapter serializes the native update selector and lock snapshot.
            ...(decoded as HostRequest<Parameters<typeof Status.resolveRequestedUpdateSlug>[0]>),
            workspaceDir: workspace,
          });
          break;
        case "clawhubUpdateTarget":
          result = await status.resolveTrackedUpdateTarget({
            // SAFETY: The paired adapter serializes native target lookup arguments; roots stay host-owned.
            ...(decoded as HostRequest<Parameters<typeof Status.resolveTrackedUpdateTarget>[0]>),
            workspaceDir: workspace,
          });
          break;
        case "clawhubUpdateGuard":
          result = await uninstall.guardTrackedSkillLocalState({
            // SAFETY: The paired adapter sends the native guard arguments; the native owner checks state.
            ...(decoded as HostRequest<
              Parameters<typeof Uninstall.guardTrackedSkillLocalState>[0]
            >),
            workspaceDir: workspace,
          });
          break;
        case "clawhubCheckInstall":
          await store.assertClawHubSkillInstallState({
            // SAFETY: The paired adapter sends native install-check arguments; workspaceDir is host-owned.
            ...(decoded as HostRequest<Parameters<typeof Store.assertClawHubSkillInstallState>[0]>),
            workspaceDir: workspace,
          });
          break;
        case "clawhubReadFiles": {
          // SAFETY: The adapter sends the installed path; its workspace boundary is checked next.
          const request = decoded as Parameters<typeof Store.readInstalledClawHubSkillFiles>[0];
          assertSkillDir(request.skillDir, workspace);
          result = await store.readInstalledClawHubSkillFiles(request);
          break;
        }
        case "clawhubRecordInstall": {
          // SAFETY: The adapter sends native provenance; path and slug consistency are checked below.
          const request = decoded as HostRequest<
            Parameters<typeof Store.recordClawHubSkillInstall>[0]
          >;
          const { resolveWorkspaceSkillInstallDir } = await import("../lifecycle/install-paths.js");
          assertSkillDir(request.skillDir, workspace);
          if (
            request.skillDir !== resolveWorkspaceSkillInstallDir(workspace, request.origin.slug)
          ) {
            throw new Error("ClawHub metadata does not match the installed skill");
          }
          await store.recordClawHubSkillInstall({ ...request, workspaceDir: workspace });
          break;
        }
        default:
          throw new Error(`Unknown skill worker operation: ${operation}`);
      }
      await write({ result: result ?? null });
    } catch (error) {
      await write({ error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  switch (operation) {
    case "readInstructions": {
      const { filePath } = decoded;
      if (typeof filePath !== "string") {
        throw new Error("Skill instruction path is required");
      }
      await write(await fs.readFile(filePath, "utf8"));
      return;
    }
    case "recordSource": {
      // SAFETY: The publisher sends native source provenance; the host derives its installation path.
      const request = decoded as Pick<Parameters<typeof recordSkillSourceInstall>[0], "origin">;
      const { recordSkillSourceInstall } = await import("../lifecycle/source-install-metadata.js");
      const { resolveWorkspaceSkillInstallDir } = await import("../lifecycle/install-paths.js");
      await recordSkillSourceInstall({
        workspaceDir: workspace,
        targetDir: resolveWorkspaceSkillInstallDir(workspace, request.origin.slug),
        origin: request.origin,
      });
      await write(null);
      return;
    }
    case "resolveResource": {
      const { resolveExplicitSkillResource } = await import("./resources.js");
      await write(
        await resolveExplicitSkillResource(
          // SAFETY: The same-version adapter serializes the selected resource's native contract.
          decoded as Parameters<typeof resolveExplicitSkillResource>[0],
        ),
      );
      return;
    }
    case "readResources": {
      // SAFETY: The same-version adapter sends the selected Skill and native missing-root policy.
      const request = decoded as {
        skill: Parameters<typeof readSkillResourceFiles>[0];
        allowMissingRoot: boolean;
      };
      const { readSkillResourceFiles } = await import("./resources.js");
      await write(
        await readSkillResourceFiles(request.skill, { allowMissingRoot: request.allowMissingRoot }),
      );
      return;
    }
    case "discovery": {
      // SAFETY: The adapter serializes the native source plan; workspace identity is checked next.
      const discovery = decoded as WorkspaceSkillSourceRequest;
      assertWorkspace(discovery, workspace);
      const { readWorkspaceSkillSources } = await import("../loading/workspace-skill-loader.js");
      await write(readWorkspaceSkillSources(discovery));
      return;
    }
    default:
      throw new Error(`Unknown skill worker operation: ${operation}`);
  }
}

function assertWorkspace(request: WatchRequest, workspace: string) {
  if (request.sourcePlan.workspaceDir !== workspace) {
    throw new Error("Skill request does not match the provisioned workspace");
  }
}

function assertSkillDir(skillDir: string, workspace: string) {
  if (path.dirname(skillDir) !== path.join(workspace, "skills")) {
    throw new Error("ClawHub skill is outside the provisioned workspace");
  }
}
