import { realpathSync, statSync } from "node:fs";
import { Option, type Command } from "commander";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import type { ManagedWorktreeService } from "../agents/worktrees/service.js";
import type {
  CreateManagedWorktreeParams,
  ManagedWorktreeGcResult,
  ManagedWorktreeGcReceipt,
  ManagedWorktreeRecord,
  ManagedWorktreeRunEndCleanup,
  RemoveManagedWorktreeResult,
} from "../agents/worktrees/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { defaultRuntime } from "../runtime.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

type JsonOption = { json?: boolean };

function mutateWorktree<T>(
  method: string,
  capability: string,
  input: Record<string, unknown>,
  run: (
    service: ManagedWorktreeService,
    guard: Pick<CreateManagedWorktreeParams, "signal" | "commitGuard">,
    config: OpenClawConfig,
  ) => Promise<T>,
): Promise<T> {
  return runWithLocalStateOwner({
    method,
    params: input,
    target: typeof input.id === "string" ? input.id : "managed worktrees",
    requiredCapabilities: [capability],
    recoveryCommand: "openclaw worktrees list --json",
    runLocal: async ({ env, config, signal, assertCurrent }) => {
      const { ManagedWorktreeService } = await import("../agents/worktrees/service.js");
      assertCurrent();
      return run(
        new ManagedWorktreeService({ env, getConfig: () => config }),
        { signal, commitGuard: assertCurrent },
        config,
      );
    },
  });
}

async function readExactStateRequest(filename: string | undefined) {
  if (!filename) {
    return undefined;
  }
  const { readFile } = await import("node:fs/promises");
  const { exactStateRetirementSchema } =
    await import("../agents/worktrees/snapshot-exact-state-contract.js");
  return exactStateRetirementSchema.parse(JSON.parse(await readFile(filename, "utf8")));
}

function printRecord(record: ManagedWorktreeRecord, json: boolean): void {
  if (json) {
    defaultRuntime.writeJson(record);
    return;
  }
  defaultRuntime.log(`${record.id}\t${record.path}`);
}

export function registerWorktreesCli(program: Command): void {
  const worktrees = program
    .command("worktrees")
    .description("Create, inspect, restore, and clean up managed worktrees");

  worktrees
    .command("list")
    .description("List active and restorable managed worktrees")
    .option("--json", "Output JSON", false)
    .action(async (opts: JsonOption) => {
      const { managedWorktrees } = await import("../agents/worktrees/service.js");
      const records = await managedWorktrees.list();
      if (opts.json) {
        defaultRuntime.writeJson({ worktrees: records });
        return;
      }
      if (records.length === 0) {
        defaultRuntime.log("No managed worktrees.");
        return;
      }
      defaultRuntime.log(
        renderTable({
          width: getTerminalTableWidth(),
          columns: [
            { key: "ID", header: "ID", minWidth: 16, flex: true },
            { key: "Repo", header: "Repo", minWidth: 18, flex: true },
            { key: "Branch", header: "Branch", minWidth: 18, flex: true },
            { key: "Status", header: "Status", minWidth: 10 },
          ],
          rows: records.map((record) => ({
            ID: record.id,
            Repo: record.repoRoot,
            Branch: record.branch,
            Status: record.removedAt ? "restorable" : "active",
          })),
        }).trimEnd(),
      );
    });

  worktrees
    .command("create")
    .description("Create a managed worktree")
    .argument("<repoRoot>", "Source git checkout")
    .option("--name <name>", "Managed worktree name")
    .option("--base-ref <ref>", "Git ref to branch from")
    .option(
      "--source-profile <name>",
      "Repository source profile; repeat to combine (default: full source)",
      (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
    )
    .option("--json", "Output JSON", false)
    .action(
      async (
        repoRoot: string,
        opts: JsonOption & { name?: string; baseRef?: string; sourceProfile?: string[] },
      ) => {
        // Match the service's physical symlink/.. resolution before yielding to admission.
        const target = realpathSync.native(repoRoot);
        const identity = statSync(target, { bigint: true });
        const input = {
          repoRoot: target,
          name: opts.name,
          baseRef: opts.baseRef,
          ...(opts.sourceProfile?.length ? { profiles: [...opts.sourceProfile] } : {}),
        };
        printRecord(
          await runWithLocalStateOwner<ManagedWorktreeRecord>({
            method: "worktrees.create",
            params: { ...input, expectedRepoIdentity: `${identity.dev}:${identity.ino}` },
            target,
            recoveryCommand: "openclaw worktrees list --json",
            assertTargetCurrent: () => {
              const current = statSync(target, { bigint: true });
              if (current.dev !== identity.dev || current.ino !== identity.ino) {
                throw new Error("Source repository changed; rerun worktrees create.");
              }
            },
            runLocal: async ({ env, config, signal, assertCurrent }) => {
              const { ManagedWorktreeService } = await import("../agents/worktrees/service.js");
              assertCurrent();
              return new ManagedWorktreeService({ env, getConfig: () => config }).create({
                ...input,
                ownerKind: "manual",
                signal,
                commitGuard: assertCurrent,
              });
            },
          }),
          opts.json === true,
        );
      },
    );

  worktrees
    .command("remove")
    .description("Snapshot and remove a managed worktree")
    .argument("<id>", "Managed worktree id")
    .option("--force", "Remove even if snapshot creation fails", false)
    .addOption(
      new Option("--if-lossless", "Remove without force only when clean and published").conflicts(
        "force",
      ),
    )
    .addOption(
      new Option(
        "--exact-state <file>",
        "Retire detached checkout using an owner-fenced exact-state JSON request",
      ).conflicts(["force", "ifLossless"]),
    )
    .option("--json", "Output JSON", false)
    .action(
      async (
        id: string,
        opts: JsonOption & { force?: boolean; ifLossless?: boolean; exactState?: string },
      ) => {
        const exactState = await readExactStateRequest(opts.exactState);
        const result = await mutateWorktree<
          RemoveManagedWorktreeResult & { cleanup?: ManagedWorktreeRunEndCleanup }
        >(
          "worktrees.remove",
          GATEWAY_SERVER_CAPS.WORKTREES_REMOVE_OWNER,
          { id, force: opts.force, ifLossless: opts.ifLossless, exactState },
          async (service, guard) => {
            if (opts.ifLossless) {
              const removed = await service.removeIfLossless(id, guard);
              const cleanup = (await service.listRegistryRecords()).find(
                (record) => record.id === id,
              )?.runEndCleanup;
              return { removed, cleanup };
            }
            return service.remove({
              id,
              ...guard,
              ...(exactState ? { exactState } : {}),
              reason: "manual-delete",
              allowSnapshotLoss: opts.force,
            });
          },
        );
        if (opts.ifLossless) {
          const { removed, cleanup } = result;
          if (opts.json) {
            defaultRuntime.writeJson({ removed, cleanup });
          } else {
            defaultRuntime.log(
              removed
                ? `Removed ${id} without force.`
                : `Retained ${id}: ${cleanup?.outcome ?? "cleanup not admitted"}.`,
            );
          }
          return;
        }
        if (opts.json) {
          defaultRuntime.writeJson(result);
        } else {
          defaultRuntime.log(
            result.recoveryPath
              ? `Retired ${id}; original source retained at ${result.recoveryPath} for the snapshot recovery period.`
              : result.snapshotError
                ? `Removed ${id} without a snapshot: ${result.snapshotError}`
                : `Removed ${id}.`,
          );
        }
      },
    );

  worktrees
    .command("retire-snapshot")
    .description("Retire one removed snapshot whose source is retained elsewhere")
    .argument("<id>", "Removed managed worktree id")
    .requiredOption("--expected-ref <ref>", "Exact snapshot ref")
    .requiredOption("--expected-oid <oid>", "Exact snapshot commit")
    .requiredOption("--removed-at <milliseconds>", "Exact recorded removal time")
    .requiredOption("--retained-ref <ref>", "Retained branch or remote-tracking source ref")
    .requiredOption("--retained-oid <oid>", "Exact retained source commit")
    .option("--json", "Output JSON", false)
    .action(
      async (
        id: string,
        opts: JsonOption & {
          expectedRef: string;
          expectedOid: string;
          removedAt: string;
          retainedRef: string;
          retainedOid: string;
        },
      ) => {
        const input = {
          id,
          expectedSnapshotRef: opts.expectedRef,
          expectedSnapshotOid: opts.expectedOid,
          expectedRemovedAt: Number(opts.removedAt),
          retainedSourceRef: opts.retainedRef,
          expectedRetainedSourceOid: opts.retainedOid,
        };
        const result = await mutateWorktree(
          "worktrees.retireSnapshot",
          GATEWAY_SERVER_CAPS.WORKTREES_RETIRE_SNAPSHOT_OWNER,
          input,
          (service, guard) => service.retireSnapshot({ ...input, ...guard }),
        );
        if (opts.json) {
          defaultRuntime.writeJson(result);
        } else {
          defaultRuntime.log(`Retired snapshot ${id}.`);
        }
      },
    );

  worktrees
    .command("recover-removal")
    .description("Resume interrupted removal from its original clean snapshot")
    .argument("<id>", "Managed worktree id")
    .requiredOption("--snapshot <oid>", "Expected pending snapshot commit")
    .option("--json", "Output JSON", false)
    .action(async (id: string, opts: JsonOption & { snapshot: string }) => {
      const input = { id, snapshot: opts.snapshot };
      const result = await mutateWorktree(
        "worktrees.recoverRemoval",
        GATEWAY_SERVER_CAPS.WORKTREES_RECOVER_REMOVAL_OWNER,
        input,
        (service, guard) => service.recoverRemoval({ ...input, ...guard }),
      );
      if (opts.json) {
        defaultRuntime.writeJson(result);
      } else {
        defaultRuntime.log(`Completed removal of ${id}; original snapshot retained.`);
      }
    });

  worktrees
    .command("restore")
    .description("Restore a managed worktree from its snapshot")
    .option(
      "--recover-exact-state <file>",
      "Reconcile a completed but unfinalized exact-state retirement using its original JSON request",
    )
    .argument("<id>", "Managed worktree id")
    .option("--json", "Output JSON", false)
    .action(async (id: string, opts: JsonOption & { recoverExactState?: string }) => {
      const recoverExactState = await readExactStateRequest(opts.recoverExactState);
      const input = { id, ...(recoverExactState ? { recoverExactState } : {}) };
      printRecord(
        await mutateWorktree(
          "worktrees.restore",
          GATEWAY_SERVER_CAPS.WORKTREES_RESTORE_OWNER,
          input,
          (service, guard) => service.restore({ ...input, ...guard }),
        ),
        opts.json === true,
      );
    });

  worktrees
    .command("gc")
    .description("Queue background managed worktree cleanup or inspect its progress")
    .option("--job <id>", "Show progress for a previously queued cleanup job")
    .option("--retry-deferred", "Reinspect unchanged deferred checkouts", false)
    .option("--json", "Output JSON", false)
    .action(async (opts: JsonOption & { job?: string; retryDeferred?: boolean }) => {
      const { formatWorktreeGcResult } = await import("../agents/worktrees/gc-result.js");
      const result = await mutateWorktree<ManagedWorktreeGcResult | ManagedWorktreeGcReceipt>(
        "worktrees.gc",
        GATEWAY_SERVER_CAPS.WORKTREES_GC_OWNER,
        {
          ...(opts.job ? { jobId: opts.job } : {}),
          ...(opts.retryDeferred ? { retryDeferred: true } : {}),
        },
        async (service, guard, config) => {
          if (opts.job) {
            throw new Error(
              "Cleanup progress belongs to the running Gateway; start it before querying this job.",
            );
          }
          const { createManagedWorktreeOwnerPolicy } =
            await import("../agents/worktrees/owner-protection.js");
          return service.gc({
            ...guard,
            retryDeferred: opts.retryDeferred,
            ...createManagedWorktreeOwnerPolicy(config),
          });
        },
      );
      if (opts.json) {
        defaultRuntime.writeJson(result);
      } else {
        defaultRuntime.log(
          "jobId" in result
            ? `Worktree cleanup ${result.state}: ${result.jobId}. ${formatWorktreeGcResult(result)}\nProgress: openclaw worktrees gc --job ${result.jobId}${result.error ? `\n${result.error}` : ""}`
            : formatWorktreeGcResult(result),
        );
      }
      if (result.outcome === "partial" || ("state" in result && result.state === "failed")) {
        const { exitCliAfterOutput } = await import("./one-shot-exit.js");
        exitCliAfterOutput(defaultRuntime, 1);
      }
    });

  applyParentDefaultHelpAction(worktrees);
}
