import { createFreeBsdPkgOwnershipInspection } from "../../infra/update-freebsd-pkg-ownership.js";
import { resolveUpdateInstallSurface } from "../../infra/update-runner.js";
import { initializeGatewayUpdateStatus } from "../../infra/update-startup.js";

export async function resolveGatewayUpdateAdmission(timeoutMs?: number) {
  const { root, status } = await initializeGatewayUpdateStatus();
  // Status discovery is read-only; admit ownership before campaign adoption
  // or a managed handoff can select and launch an updater.
  await createFreeBsdPkgOwnershipInspection(timeoutMs).assertUnowned(root);
  const installSurface = await resolveUpdateInstallSurface({
    root,
    installKind: status.installKind,
    timeoutMs,
  });
  return { status, installSurface };
}
