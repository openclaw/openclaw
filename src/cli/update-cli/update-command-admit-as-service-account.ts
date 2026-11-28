import fs from "node:fs/promises";
import path from "node:path";
import type { UpdateAdmissionContext } from "../../infra/update-admission-contract.js";
import {
  parseUpdateAdmissionVerdict,
  UPDATE_ADMISSION_PROTOCOL,
  type UpdateAdmissionVerdict,
} from "../../infra/update-run-schema.js";
import {
  createServiceAccountHandoff,
  runReleaseAsServiceAccount,
  type ServiceAccountExecution,
} from "./update-command-service-account-run.js";

/**
 * Installed updaters stage the candidate in a private (0700) directory, which the account
 * cannot enter. For the account's admission only, root adds the traverse bit for others to
 * its own ancestors that lack it (no listing, no write), and puts each mode back after.
 * The package's own files are world-readable, as npm installs them.
 */
async function grantStagedReleaseTraversal(candidateRoot: string) {
  const changed: { directory: string; mode: number }[] = [];
  const restore = async () => {
    for (const { directory, mode } of changed.toReversed()) {
      await fs.chmod(directory, mode);
    }
  };
  try {
    const real = await fs.realpath(candidateRoot);
    for (let directory = real; ; directory = path.dirname(directory)) {
      const info = await fs.lstat(directory);
      if (!info.isDirectory()) {
        throw new Error("the staged release path is not a directory chain");
      }
      if ((info.mode & 0o001) === 0) {
        // Only directories this updater owns, i.e. root's.
        if (info.uid !== (process.getuid?.() ?? 0)) {
          throw new Error("the staged release path is not owned by this updater");
        }
        changed.push({ directory, mode: info.mode & 0o7777 });
        await fs.chmod(directory, (info.mode & 0o7777) | 0o001);
      }
      if (directory === path.dirname(directory)) {
        break;
      }
    }
  } catch (error) {
    await restore();
    throw error;
  }
  return { restore };
}

const SYSTEM_SERVICE_UPDATE_DOCS =
  "https://docs.openclaw.ai/install/updating#linux-system-service-run-by-another-account";

/**
 * Run this candidate's own admission as the unit's account against the unit's state. The
 * account's answer is untrusted: it must be one bounded, well-formed verdict whose exit status
 * and candidate version agree with what root derived itself, or the update refuses.
 */
export async function admitAsServiceAccount(
  execution: ServiceAccountExecution,
  context: UpdateAdmissionContext,
  facts: { candidateRoot: string; candidateVersion: string; installedVersion: string | null },
): Promise<UpdateAdmissionVerdict> {
  const check = {
    name: "managed-service-account",
    status: "ok" as const,
    detail: `Checked as ${execution.account} with ${execution.unitName}'s state.`,
  };
  const refuse = (problem: string): UpdateAdmissionVerdict => {
    const message = `Gateway service ${execution.unitName} runs as ${execution.account}; its state could not be checked as ${execution.account} (${problem}).`;
    return {
      protocol: UPDATE_ADMISSION_PROTOCOL,
      verdict: "refuse",
      reasons: [
        {
          code: "service-account-mismatch",
          message,
          nextAction: `Nothing was changed. See ${SYSTEM_SERVICE_UPDATE_DOCS} to update this system service by hand.`,
        },
      ],
      warnings: [],
      facts: {
        candidateVersion: facts.candidateVersion,
        installedVersion: facts.installedVersion,
        checks: [{ name: check.name, status: "refuse", detail: message }],
      },
    };
  };
  // Runtime selectors the installed updater set for this candidate, never root's state.
  const handoff = await createServiceAccountHandoff(execution, {
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_DEV_SOURCE_ROOT: facts.candidateRoot,
    ...(context.target.version !== null ? { OPENCLAW_VERSION: context.target.version } : {}),
  });
  let result: Awaited<ReturnType<typeof runReleaseAsServiceAccount>>;
  let traversal: Awaited<ReturnType<typeof grantStagedReleaseTraversal>> | undefined;
  try {
    traversal = await grantStagedReleaseTraversal(facts.candidateRoot);
    const file = await handoff.write("context.json", JSON.stringify(context));
    result = await runReleaseAsServiceAccount(execution, handoff, {
      root: facts.candidateRoot,
      args: ["update", "admit", "--context", file],
      timeoutMs: context.request.timeoutMs ?? 120_000,
    });
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  } finally {
    await traversal?.restore();
    await handoff.remove();
  }
  if (result.termination !== "exit" || (result.code !== 0 && result.code !== 3)) {
    // Diagnostic only: the account's error line (or its last line), printable, bounded.
    const lines = result.stderr.toString("utf8").trim().split("\n");
    const reason = (
      lines.find((line) => /\b\w*Error\b:/u.test(line)) ??
      lines.filter((line) => !line.startsWith("Node.js v")).at(-1)
    )
      ?.replace(/[^\x20-\x7e]/gu, "")
      .trim()
      .slice(0, 160);
    return refuse(
      `${result.termination === "exit" ? `exit ${result.code}` : `admission ${result.termination}`}${reason ? `: ${reason}` : ""}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    return refuse("malformed verdict");
  }
  const verdict = parseUpdateAdmissionVerdict(value);
  if (
    !verdict ||
    result.code !== (verdict.verdict === "admit" ? 0 : 3) ||
    verdict.facts.candidateVersion !== facts.candidateVersion ||
    verdict.facts.checks.some((entry) => entry.name === check.name)
  ) {
    return refuse("invalid verdict");
  }
  // The combined verdict must still satisfy the wire contract the installed updater parses.
  return (
    parseUpdateAdmissionVerdict({
      ...verdict,
      facts: {
        ...verdict.facts,
        installedVersion: facts.installedVersion,
        checks: [check, ...verdict.facts.checks],
      },
    }) ?? refuse("verdict too large")
  );
}
