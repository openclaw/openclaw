import fs from "node:fs/promises";
import path from "node:path";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import type { UpdateAdmissionContext } from "../../infra/update-admission-contract.js";
import {
  parseUpdateAdmissionVerdict,
  UPDATE_ADMISSION_PROTOCOL,
  type UpdateAdmissionVerdict,
} from "../../infra/update-run-schema.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import {
  createServiceAccountHandoff,
  runReleaseAsServiceAccount,
  type ServiceAccountExecution,
} from "./update-command-service-account-run.js";

/** Time this process keeps, after the account's run, to clean up and print its refusal. */
const ADMISSION_RESERVE_MS = 5_000;

/**
 * Installed updaters stage the candidate in a private (0700) directory of their own
 * (`.openclaw.update-stage-*`) that holds only the staged package, which the account cannot
 * enter. For the account's admission, root adds the traverse bit of the class the account
 * falls in to that one directory and puts its mode back after; the package's files are
 * world-readable as npm installs them. If any other ancestor is not traversable for the
 * account (judged by owner, primary group, then others), nothing changes and admission
 * refuses.
 */
async function grantStagedReleaseTraversal(
  candidateRoot: string,
  account: { uid: number; gid: number },
) {
  const traverseBit = (info: { uid: number; gid: number }) =>
    info.uid === account.uid ? 0o100 : info.gid === account.gid ? 0o010 : 0o001;
  let changed: { directory: string; mode: number } | undefined;
  const restore = async () => {
    if (changed) {
      await fs.chmod(changed.directory, changed.mode);
    }
  };
  const real = await fs.realpath(candidateRoot);
  for (let directory = real; ; directory = path.dirname(directory)) {
    const info = await fs.lstat(directory);
    if (!info.isDirectory()) {
      await restore();
      throw new Error("the staged release path is not a directory chain");
    }
    const bit = traverseBit(info);
    if ((info.mode & bit) === 0) {
      if (
        changed ||
        !path.basename(directory).startsWith(".openclaw.update-stage-") ||
        info.uid !== (process.getuid?.() ?? 0)
      ) {
        await restore();
        throw new Error("the staged release is inside a directory the account cannot enter");
      }
      changed = { directory, mode: info.mode & 0o7777 };
      await fs.chmod(directory, changed.mode | bit);
    }
    if (directory === path.dirname(directory)) {
      break;
    }
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
  // The installed updater ends this process at its own deadline and then falls back to its
  // own checks of root's state. Return a refusal well before that: its budget runs from when
  // it started this process, less its cleanup reserve, less time for our cleanup and output.
  const budgetMs = resolveTimerTimeoutMs(context.request.timeoutMs, 120_000);
  const accountTimeoutMs =
    budgetMs -
    Math.min(2_000, Math.floor(budgetMs / 10)) -
    ADMISSION_RESERVE_MS -
    Math.ceil(process.uptime() * 1000);
  if (accountTimeoutMs < 1_000) {
    return refuse("no time was left for the account's checks");
  }
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
    traversal = await grantStagedReleaseTraversal(facts.candidateRoot, execution);
    const file = await handoff.write("context.json", JSON.stringify(context));
    result = await runReleaseAsServiceAccount(execution, handoff, {
      root: facts.candidateRoot,
      args: ["update", "admit", "--context", file],
      timeoutMs: accountTimeoutMs,
    });
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  } finally {
    await traversal?.restore();
    await handoff.remove();
  }
  // A clean-looking verdict does not count while the account's processes may still run.
  if (hasCommandProcessCleanupError(result.error)) {
    return refuse("the account's admission processes could not be confirmed stopped");
  }
  if (result.termination !== "exit" || (result.code !== 0 && result.code !== 3)) {
    // Diagnostic only: the account's error line (or its last line), printable, bounded.
    const lines = result.stderr.toString("utf8").trim().split("\n");
    const reason = (
      lines.find((line) => /\b\w*Error\b:/u.test(line)) ??
      lines.findLast((line) => !line.startsWith("Node.js v"))
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
