import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { openPackageActivationJournal } from "./package-update-activation-journal.js";
import { readPackageReverseGenerations } from "./package-update-activation-reverse-binding.js";
import {
  packageActivationReverseBindingSchema,
  type PackageActivationReverseBinding,
} from "./package-update-activation-reverse-schema.js";
import type { PackageReverseAuthority } from "./package-update-activation-reverse.js";
import type { PackageReversePublication } from "./package-update-swap-contract.js";
import {
  assertSelectedOriginalRuntime,
  selectedOriginalRoot,
} from "./update-recovery-startup-protocol.js";

export type UpdateRecoveryTargetPreflight = {
  selection: PackageReversePublication["selection"];
  timeoutMs: number;
  signal?: AbortSignal;
};
export type UpdateRecoveryStartupAdmission = {
  target: PackageActivationReverseBinding["target"];
  validateTarget: PackageReverseAuthority["validateTarget"];
};

const preflightResult = z
  .object({
    schema: z.enum(["openclaw.state-schema-preflight.v1", "openclaw.agent-schema-preflight.v1"]),
    status: z.string(),
    foundVersion: z.number().int().nullable(),
    targetVersion: z.number().int(),
    requiresWrite: z.boolean(),
    issues: z.array(z.unknown()),
  })
  .passthrough();

/** Run only the selected release's shipped explicit copied-database preflight.
 * The previous runtime never receives a new recovery flag or writer authority. */
export async function admitSelectedRuntimeUpdateRecoveryPublication(
  generations: Pick<PackageActivationReverseBinding, "baseline" | "candidate" | "prepared">,
  authority: { assertOwned: () => void },
  target: UpdateRecoveryTargetPreflight,
  durable?: Readonly<PackageActivationReverseBinding>,
): Promise<UpdateRecoveryStartupAdmission> {
  if (!Number.isFinite(target.timeoutMs) || target.timeoutMs <= 0) {
    throw new Error("Target preflight requires a finite positive execution budget.");
  }
  const assertOriginalOwned = authority.assertOwned.bind(authority);
  const selectOriginal = target.selection.bind(target);
  const signal = target.signal;
  const timeoutMs = target.timeoutMs;
  assertOriginalOwned();
  const selection = structuredClone(selectOriginal());
  const captured = structuredClone(generations);
  const assertOwned = () => {
    signal?.throwIfAborted();
    assertOriginalOwned();
    if (!isDeepStrictEqual(selection, selectOriginal())) {
      throw new Error("Target preflight lost the original runtime selection.");
    }
  };
  const execute = async (binding?: Readonly<PackageActivationReverseBinding>) => {
    const deadline = performance.now() + timeoutMs;
    assertOwned();
    const journal = openPackageActivationJournal(selection.anchor);
    const record = journal.read();
    const descriptor = record.descriptor;
    if (
      !isDeepStrictEqual(
        {
          anchor: selection.anchor,
          operationId: descriptor.operationId,
          originalRunId: descriptor.originalRunId,
          previous: descriptor.previous,
          previousRuntime: descriptor.previousRuntime,
        },
        selection,
      ) ||
      !descriptor.originalRunId
    ) {
      throw new Error("Target preflight selection is not the original journal selection.");
    }
    const root = selectedOriginalRoot(selection.anchor, descriptor);
    const manifests = readPackageReverseGenerations(
      captured,
      descriptor.originalRunId,
      descriptor.authority.installKey,
    );
    const runtime = await assertSelectedOriginalRuntime(root, descriptor);
    assertOwned();
    journal.assertCurrent(record);
    if (binding) {
      const parsed = packageActivationReverseBindingSchema.parse(binding);
      if (
        !isDeepStrictEqual(
          { baseline: parsed.baseline, candidate: parsed.candidate, prepared: parsed.prepared },
          captured,
        ) ||
        (descriptor.reverse && !isDeepStrictEqual(descriptor.reverse, parsed))
      ) {
        throw new Error("Target preflight changed its durable reverse binding.");
      }
    }
    const results: unknown[] = [];
    for (const database of manifests.prepared.databases ?? []) {
      const entry = manifests.prepared.entries.find((item) => item.sourcePath === database.path);
      if (entry?.kind !== "file" || !entry.sqlite) {
        throw new Error(`Target preflight lacks a prepared database payload: ${database.path}`);
      }
      const payload = path.join(captured.prepared.directory, entry.archivePath);
      const args =
        database.role === "agent"
          ? [
              runtime.nodePath,
              path.join(root, runtime.entrypoint),
              "database",
              "preflight-agent",
              payload,
              "--agent-id",
              database.agentId,
              "--json",
            ]
          : [
              runtime.nodePath,
              path.join(root, runtime.entrypoint),
              "database",
              "preflight",
              payload,
              "--json",
            ];
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new Error("Target database preflight deadline expired.");
      }
      const result = await runUtf8CommandWithTimeout(args, {
        cwd: root,
        baseEnv: { PATH: path.dirname(runtime.nodePath) },
        timeoutMs: Math.floor(remaining),
        signal,
        killProcessTree: true,
        requireProcessTreeExtinction: true,
        maxOutputBytes: 1024 * 1024,
        terminateOnOutputLimit: true,
      });
      if (result.cleanup === "uncertain") {
        throw new CommandProcessCleanupError();
      }
      assertOwned();
      journal.assertCurrent(record);
      if (
        result.code !== 0 ||
        result.termination !== "exit" ||
        result.signal ||
        result.killed ||
        result.outputLimitExceeded ||
        result.outputErrorStream ||
        result.stdoutTruncatedBytes ||
        result.stderrTruncatedBytes
      ) {
        throw new Error(
          `Selected runtime database preflight failed: ${result.stderr.slice(-2048)}`,
        );
      }
      const response = preflightResult.parse(JSON.parse(result.stdout));
      if (
        response.status !== "exact" ||
        response.requiresWrite ||
        response.issues.length ||
        response.foundVersion !== response.targetVersion ||
        (database.role === "agent"
          ? response.schema !== "openclaw.agent-schema-preflight.v1"
          : response.schema !== "openclaw.state-schema-preflight.v1")
      ) {
        throw new Error(`Selected runtime cannot serve prepared database: ${database.path}`);
      }
      results.push(response);
    }
    await assertSelectedOriginalRuntime(root, descriptor);
    assertOwned();
    journal.assertCurrent(record);
    return { runtime, results };
  };
  const retained = durable && packageActivationReverseBindingSchema.parse(durable);
  const admitted = await execute(retained);
  if (retained) {
    const { admissionSha256: _admission, startupProtocol: _startup, ...runtime } = retained.target;
    if (!isDeepStrictEqual(runtime, admitted.runtime)) {
      throw new Error("Durable recovery target changed its selected runtime.");
    }
  }
  const selected: PackageActivationReverseBinding["target"] = {
    ...admitted.runtime,
    startupProtocol: "package-state-reverse-v1",
    admissionSha256: createHash("sha256").update(JSON.stringify(admitted.results)).digest("hex"),
  };
  const originalTarget = structuredClone(retained?.target ?? selected);
  return {
    target: originalTarget,
    validateTarget: async (binding) => {
      assertOwned();
      if (
        !isDeepStrictEqual(binding.target, originalTarget) ||
        !isDeepStrictEqual(
          { baseline: binding.baseline, candidate: binding.candidate, prepared: binding.prepared },
          captured,
        )
      ) {
        throw new Error("Target callback changed its admitted runtime or generations.");
      }
      await execute(packageActivationReverseBindingSchema.parse(binding));
      assertOwned();
    },
  };
}
