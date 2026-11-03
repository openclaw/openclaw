import {
  formatInstallOwnerMessage,
  readInstallOwner,
  type InstallOwner,
} from "../../infra/install-owner.js";
import { defaultRuntime } from "../../runtime.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";

/** Refuse before update admission can touch service, package, or operator state. */
export async function refuseHostOwnedUpdate(root: string, opts: { json?: boolean }): Promise<void> {
  const installOwner = await readInstallOwner(root);
  if (installOwner) {
    reportHostOwnedUpdate(installOwner, opts);
  }
}

export function reportHostOwnedUpdate(
  installOwner: InstallOwner | null,
  opts: { json?: boolean },
): never {
  const message = installOwner
    ? formatInstallOwnerMessage(installOwner)
    : "This installation is managed by its host. Update it through the host application.";
  if (opts.json) {
    defaultRuntime.writeJson({
      status: "host-managed",
      reason: "host-owned-install",
      installKind: "host",
      installOwner,
      message,
      steps: [],
    });
  } else {
    defaultRuntime.error(message);
  }
  exitCliAfterOutput(defaultRuntime, 1);
}
