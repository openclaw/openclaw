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
  "Preparation only. Enable activation explicitly with openclaw update adopt-immutable --enable-activation and the installation's original adoption arguments.";

type ActivationResult = Awaited<
  ReturnType<typeof import("../../infra/update-immutable-activation.js").activateImmutableUpdate>
>;

const ACTIVATION_MESSAGES: Record<Exclude<ActivationResult["status"], "error">, string> = {
  succeeded: "Immutable activation verified; the recovery record was retired.",
  "rolled-back":
    "The sealed predecessor is serving. The activation record remains available for openclaw update recover.",
  "already-current": "The immutable installation has no activation work to recover.",
  pending:
    "Immutable activation remains pending. Run openclaw update recover --root <installation-root> to verify the serving generation.",
};

function activationMessage(result: ActivationResult): string {
  return result.status === "error"
    ? `Immutable activation failed: ${result.reason ?? "inspect the retained activation record"}.`
    : ACTIVATION_MESSAGES[result.status];
}

function exitFailedActivation(result: ActivationResult): void {
  if (!["succeeded", "already-current"].includes(result.status)) {
    exitCliAfterOutput(defaultRuntime, 1);
  }
}

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
      "Immutable installations use openclaw update for preparation and enabled activation, or openclaw update recover --root <installation-root> for retained recovery. update repair does not own this installation.",
      opts.json,
      "immutable-repair-unsupported",
    );
  }
}

/** Dispatch before the mutable updater admits state, retains runtime, or inspects services. */
export async function tryRunImmutableUpdateCommand(opts: UpdateCommandOptions): Promise<boolean> {
  const root =
    opts.recipe?.maintenance.expected.installationRoot ??
    opts.sourceUpdate?.root ??
    (await resolveUpdateRoot());
  let installation: Awaited<ReturnType<typeof inspectImmutableInstall>>;
  try {
    installation = await inspectImmutableInstall(root);
  } catch (error) {
    return reportImmutableFailure(error, opts.json);
  }
  if (!installation) {
    if (opts.drainTimeout !== undefined) {
      throw new Error("--drain-timeout requires an adopted immutable installation.");
    }
    return false;
  }
  if (opts.recipe) {
    throw new Error("Recipe execution has not qualified immutable installation activation.");
  }

  let result: Awaited<ReturnType<typeof prepareImmutableUpdate>>;
  let drainTimeoutMs: number | undefined;
  try {
    drainTimeoutMs = parseUpdateTimeoutMs(opts.drainTimeout, "--drain-timeout");
    if (
      (opts.channel !== undefined && opts.channel !== "dev") ||
      opts.tag !== undefined ||
      opts.reapplyLocalOverrides ||
      opts.sourceUpdate ||
      opts.recovery ||
      opts.run
    ) {
      throw new Error(
        "Immutable updates support official main or --sha only. Use openclaw update recover --root <installation-root> for retained activation recovery; channel switching and package overrides are unsupported.",
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
  const receipts: string[] = [];
  let activation: ActivationResult | "disabled" | "skipped" | "planned" | "not-needed" =
    !installation.activationEnabled
      ? "disabled"
      : opts.restart === false
        ? "skipped"
        : result.status === "dry-run"
          ? "planned"
          : "not-needed";
  if (result.status === "prepared" && installation.activationEnabled && opts.restart !== false) {
    try {
      const { activateImmutableUpdate } =
        await import("../../infra/update-immutable-activation.js");
      const expectedPrepared = result.installation.prepared;
      if (!expectedPrepared) {
        throw new Error(
          "Immutable preparation returned no generation receipt; activation was not attempted.",
        );
      }
      activation = await activateImmutableUpdate({
        root: installation.root,
        expectedPrepared,
        timeoutMs: parseUpdateTimeoutMs(opts.timeout),
        drainTimeoutMs,
        onReceipt: (line) => {
          receipts.push(line);
          if (!opts.json) {
            defaultRuntime.log(line);
          }
        },
      });
    } catch (error) {
      return reportImmutableFailure(error, opts.json, "immutable-activation-failed");
    }
  }
  const message =
    result.status === "error"
      ? "Immutable preparation failed; the selected generation was preserved."
      : typeof activation !== "string"
        ? activationMessage(activation)
        : activation === "disabled"
          ? PREPARATION_ONLY
          : activation === "skipped"
            ? "Sealed generation preparation completed; activation was skipped by --no-restart."
            : activation === "planned"
              ? "Would activate the prepared generation under the enabled adoption record."
              : "No immutable activation was needed.";
  if (opts.json) {
    defaultRuntime.writeJson({
      ...result,
      ...(typeof activation !== "string"
        ? { status: activation.status, installation: activation.installation }
        : {}),
      installKind: "immutable",
      activation,
      receipts,
      message,
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
    defaultRuntime.log(message);
    if (typeof activation !== "string" && activation.recoveryCommand) {
      defaultRuntime.log(`Recovery: ${activation.recoveryCommand}`);
    }
  }
  if (result.status === "error") {
    exitCliAfterOutput(defaultRuntime, 1);
  }
  if (typeof activation !== "string") {
    exitFailedActivation(activation);
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
      activation: installation.activationEnabled ? "enabled" : "disabled",
    });
  } else {
    defaultRuntime.log(
      installation.activationEnabled
        ? "Recorded immutable installation ownership with native activation enabled. openclaw update can prepare, activate, and verify sealed generations."
        : "Recorded immutable installation ownership. openclaw update can now prepare sealed generations.",
    );
    if (!installation.activationEnabled) {
      defaultRuntime.log(PREPARATION_ONLY);
    }
  }
}

export async function updateRecoverImmutableCommand(opts: {
  root: string;
  timeout?: string;
  drainTimeout?: string;
  json?: boolean;
}): Promise<void> {
  const receipts: string[] = [];
  let result: ActivationResult;
  try {
    const { recoverImmutableUpdate } = await import("../../infra/update-immutable-activation.js");
    result = await recoverImmutableUpdate({
      root: opts.root,
      timeoutMs: parseUpdateTimeoutMs(opts.timeout),
      drainTimeoutMs: parseUpdateTimeoutMs(opts.drainTimeout, "--drain-timeout"),
      onReceipt: (line) => {
        receipts.push(line);
        if (!opts.json) {
          defaultRuntime.log(line);
        }
      },
    });
  } catch (error) {
    return reportImmutableFailure(error, opts.json, "immutable-recovery-failed");
  }
  if (opts.json) {
    defaultRuntime.writeJson({ ...result, installKind: "immutable", receipts });
  } else {
    defaultRuntime.log(activationMessage(result));
    if (result.recoveryCommand) {
      defaultRuntime.log(`Recovery: ${result.recoveryCommand}`);
    }
  }
  exitFailedActivation(result);
}
