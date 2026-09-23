/** Optional pre-doctor update prompt for source checkouts and package installs. */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "../infra/update-run-timeouts.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { isServiceRepairDeferred } from "./doctor-service-repair-policy.js";

async function resolveComparablePath(target: string): Promise<string> {
  return await fs.realpath(target).catch(() => path.resolve(target));
}

async function detectOpenClawGitCheckout(root: string): Promise<"git" | "not-git" | "unknown"> {
  const res = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "--show-toplevel"], {
    timeoutMs: 5000,
  }).catch(() => null);
  if (!res) {
    return "unknown";
  }
  if (res.code !== 0) {
    // Avoid noisy "Update via package manager" notes when git is missing/broken,
    // but do show it when this is clearly not a git checkout.
    if (normalizeLowercaseStringOrEmpty(res.stderr).includes("not a git repository")) {
      return "not-git";
    }
    return "unknown";
  }
  const gitRoot = res.stdout.trim();
  return (await resolveComparablePath(gitRoot)) === (await resolveComparablePath(root))
    ? "git"
    : "not-git";
}

/** Offers to update OpenClaw before doctor when running interactively from an updatable install. */
export async function maybeOfferUpdateBeforeDoctor(params: {
  options: DoctorOptions;
  root: string | null;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
  outro: (message: string) => void;
}): Promise<{
  updated: boolean;
  handled?: boolean;
  reason?: "gateway-readiness-unverified" | "still-starting";
}> {
  const updateInProgress = isTruthyEnvValue(process.env.OPENCLAW_UPDATE_IN_PROGRESS);
  const canOfferUpdate =
    !updateInProgress &&
    params.options.nonInteractive !== true &&
    params.options.yes !== true &&
    params.options.repair !== true &&
    process.stdin.isTTY;
  if (!canOfferUpdate || !params.root) {
    return { updated: false };
  }

  const git = await detectOpenClawGitCheckout(params.root);
  if (git === "git") {
    if (isServiceRepairDeferred()) {
      note(
        "Update through the external supervisor's stop/update/finalize/restart workflow. Continuing Doctor without updating OpenClaw.",
        "Update",
      );
      return { updated: false };
    }
    const shouldUpdate = await params.confirm({
      message: "Update OpenClaw from git before running doctor?",
      initialValue: true,
    });
    if (!shouldUpdate) {
      return { updated: false };
    }
    const { updateCommand } = await import("../cli/update-cli/update-command.js");
    let handled = false;
    let readinessReason: "gateway-readiness-unverified" | "still-starting" | undefined;
    await updateCommand({
      sourceUpdate: { root: params.root },
      timeout: String(UPDATE_RUNNER_TIMEOUT_MS / 1000),
      onResult: (result) => {
        readinessReason =
          result.status === "skipped" &&
          (result.reason === "gateway-readiness-unverified" || result.reason === "still-starting")
            ? result.reason
            : undefined;
        handled = result.status === "ok" || readinessReason !== undefined;
      },
    });
    if (handled) {
      params.outro(
        readinessReason
          ? "OpenClaw installed; Gateway readiness remains unverified. Keep recovery backups and check `openclaw gateway status --deep`."
          : "Update completed (doctor already ran as part of the update).",
      );
    }
    return {
      updated: true,
      handled,
      ...(readinessReason ? { reason: readinessReason } : {}),
    };
  }

  if (git === "not-git") {
    note(
      [
        "This install is not a git checkout.",
        `Run \`${formatCliCommand("openclaw update")}\` to update via your package manager (npm/pnpm), then rerun doctor.`,
      ].join("\n"),
      "Update",
    );
  }

  return { updated: false };
}
