import { Option, type Command } from "commander";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { defaultRuntime } from "../runtime.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

type JsonOption = { json?: boolean };

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
        const { managedWorktrees } = await import("../agents/worktrees/service.js");
        printRecord(
          await managedWorktrees.create({
            repoRoot,
            name: opts.name,
            baseRef: opts.baseRef,
            ...(opts.sourceProfile?.length ? { profiles: opts.sourceProfile } : {}),
            ownerKind: "manual",
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
        const { managedWorktrees } = await import("../agents/worktrees/service.js");
        if (opts.ifLossless) {
          const removed = await managedWorktrees.removeIfLossless(id);
          const cleanup = (await managedWorktrees.listRegistryRecords()).find(
            (record) => record.id === id,
          )?.runEndCleanup;
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
        const exactState = await readExactStateRequest(opts.exactState);
        const result = await managedWorktrees.remove({
          id,
          ...(exactState ? { exactState } : {}),
          reason: "manual-delete",
          allowSnapshotLoss: opts.force,
        });
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
        const { retireManagedWorktreeSnapshotById } =
          await import("../agents/worktrees/snapshot-host.js");
        const result = await retireManagedWorktreeSnapshotById({
          id,
          expectedSnapshotRef: opts.expectedRef,
          expectedSnapshotOid: opts.expectedOid,
          expectedRemovedAt: Number(opts.removedAt),
          retainedSourceRef: opts.retainedRef,
          expectedRetainedSourceOid: opts.retainedOid,
        });
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
      const { managedWorktrees } = await import("../agents/worktrees/service.js");
      const result = await managedWorktrees.recoverRemoval({ id, snapshot: opts.snapshot });
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
      const { managedWorktrees } = await import("../agents/worktrees/service.js");
      const recoverExactState = await readExactStateRequest(opts.recoverExactState);
      printRecord(
        await managedWorktrees.restore({ id, ...(recoverExactState ? { recoverExactState } : {}) }),
        opts.json === true,
      );
    });

  worktrees
    .command("gc")
    .description("Run managed worktree cleanup now")
    .option("--json", "Output JSON", false)
    .action(async (opts: JsonOption) => {
      const { formatWorktreeGcResult } = await import("../agents/worktrees/gc-result.js");
      const { createManagedWorktreeOwnerPolicy } =
        await import("../agents/worktrees/owner-protection.js");
      const { managedWorktrees, resolveWorktreeCleanupLimits } =
        await import("../agents/worktrees/service.js");
      const { getRuntimeConfig } = await import("../config/config.js");
      const cfg = getRuntimeConfig();
      const limits = resolveWorktreeCleanupLimits();
      const result = await managedWorktrees.gc({
        limits,
        retryDeferred: true,
        ...createManagedWorktreeOwnerPolicy(cfg),
      });
      if (opts.json) {
        defaultRuntime.writeJson(result);
      } else {
        defaultRuntime.log(formatWorktreeGcResult(result));
      }
      if (result.outcome === "partial") {
        const { exitCliAfterOutput } = await import("./one-shot-exit.js");
        exitCliAfterOutput(defaultRuntime, 1);
      }
    });

  applyParentDefaultHelpAction(worktrees);
}
