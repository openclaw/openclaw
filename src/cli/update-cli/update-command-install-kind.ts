import { readInstallOwner } from "../../infra/install-owner.js";
import { resolveUpdateInstallKind } from "../../infra/update-check.js";
import { reportHostOwnedUpdate } from "./host-owned.js";
import type { UpdateCommandOptions } from "./shared.js";

/** Mutable lifecycle admission excludes installations owned by another update path. */
export async function resolveMutableUpdateInstallKind(
  root: string,
  opts: UpdateCommandOptions,
  timeoutMs?: number,
) {
  const installKind = await resolveUpdateInstallKind(root, { timeoutMs });
  if (installKind === "host") {
    reportHostOwnedUpdate(await readInstallOwner(root), opts);
  }
  if (installKind === "immutable") {
    throw new Error(
      "Immutable installations require the preparation-only openclaw update entry point.",
    );
  }
  if (opts.sha !== undefined) {
    throw new Error("--sha requires an adopted immutable installation.");
  }
  return installKind;
}
