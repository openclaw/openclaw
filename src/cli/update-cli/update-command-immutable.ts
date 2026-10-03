import { formatErrorMessage } from "../../infra/errors.js";
import {
  adoptImmutableInstall,
  inspectImmutableInstall,
  prepareImmutableUpdate,
} from "../../infra/update-immutable-install.js";
import { defaultRuntime } from "../../runtime.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { parseUpdateTimeoutMs, resolveUpdateRoot, type UpdateCommandOptions } from "./shared.js";

const PREPARATION_ONLY =
  "Immutable activation is not available yet. The current generation keeps serving; no pointer or service was changed.";

function reportImmutableFailure(
  error: unknown,
  json?: boolean,
  reason = "immutable-preparation-refused",
): never {
  const message = formatErrorMessage(error);
  if (json) {
    defaultRuntime.writeJson({
      status: "error",
      installKind: "immutable",
      reason,
      message,
      activation: "unavailable",
    });
  } else {
    defaultRuntime.error(message);
  }
  return exitCliAfterOutput(defaultRuntime, 1);
}

export async function refuseImmutableUpdateActivation(
  root: string,
  opts: { json?: boolean },
): Promise<void> {
  let installation: Awaited<ReturnType<typeof inspectImmutableInstall>>;
  try {
    installation = await inspectImmutableInstall(root);
  } catch (error) {
    return reportImmutableFailure(error, opts.json);
  }
  if (installation) {
    reportImmutableFailure(
      `${PREPARATION_ONLY} Run openclaw update to prepare a sealed generation.`,
      opts.json,
      "immutable-activation-unavailable",
    );
  }
}

/** Dispatch before the mutable updater admits state, retains runtime, or inspects services. */
export async function tryRunImmutableUpdateCommand(opts: UpdateCommandOptions): Promise<boolean> {
  const root = opts.sourceUpdate?.root ?? (await resolveUpdateRoot());
  let installation: Awaited<ReturnType<typeof inspectImmutableInstall>>;
  try {
    installation = await inspectImmutableInstall(root);
  } catch (error) {
    return reportImmutableFailure(error, opts.json);
  }
  if (!installation) {
    return false;
  }
  let result: Awaited<ReturnType<typeof prepareImmutableUpdate>>;
  try {
    if (
      (opts.channel !== undefined && opts.channel !== "dev") ||
      opts.tag !== undefined ||
      opts.reapplyLocalOverrides ||
      opts.sourceUpdate ||
      opts.recovery ||
      opts.run
    ) {
      throw new Error(
        "Immutable preparation supports official main or --sha only. Channel switching, package overrides, and activation recovery are unavailable.",
      );
    }
    result = await prepareImmutableUpdate({
      root,
      sha: opts.sha,
      dryRun: opts.dryRun,
      timeoutMs: parseUpdateTimeoutMs(opts.timeout),
    });
  } catch (error) {
    return reportImmutableFailure(error, opts.json);
  }
  if (opts.json) {
    defaultRuntime.writeJson({
      ...result,
      installKind: "immutable",
      activation: "unavailable",
      message: PREPARATION_ONLY,
    });
  } else {
    const target = result.targetSha ? ` ${result.targetSha}` : "";
    defaultRuntime.log(
      result.status === "already-current"
        ? `Immutable generation${target} is already current.`
        : result.status === "dry-run"
          ? `Would prepare immutable generation${target}.`
          : result.status === "prepared"
            ? `Prepared immutable generation${target}.`
            : `Immutable preparation failed: ${result.reason ?? "candidate preparation failed"}.`,
    );
    for (const warning of result.warnings) {
      defaultRuntime.error(`Warning: ${warning}`);
    }
    defaultRuntime.log(PREPARATION_ONLY);
  }
  if (result.status === "error") {
    exitCliAfterOutput(defaultRuntime, 1);
  }
  return true;
}

export async function updateAdoptImmutableCommand(
  opts: Parameters<typeof adoptImmutableInstall>[0] & { json?: boolean },
): Promise<void> {
  let installation: Awaited<ReturnType<typeof adoptImmutableInstall>>;
  try {
    installation = await adoptImmutableInstall(opts);
  } catch (error) {
    return reportImmutableFailure(error, opts.json);
  }
  if (opts.json) {
    defaultRuntime.writeJson({
      status: "adopted",
      installKind: "immutable",
      installation,
      activation: "unavailable",
    });
  } else {
    defaultRuntime.log(
      "Recorded immutable installation ownership. openclaw update can now prepare sealed generations.",
    );
    defaultRuntime.log(PREPARATION_ONLY);
  }
}
