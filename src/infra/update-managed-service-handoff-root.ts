import { resolvePnpmGlobalInstallOwner } from "./update-global.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";

export async function assertManagedServiceUpdateHandoffRoot(params: {
  expectedRoot: string;
  root: string;
  executingRoot: string | null;
  postCore: boolean;
}): Promise<void> {
  const expectedRoot = resolveUpdateInstallRoot(params.expectedRoot);
  const root = params.executingRoot ? resolveUpdateInstallRoot(params.executingRoot) : null;
  const activeExecution = root !== null && resolveUpdateInstallRoot(params.root) === root;
  if (activeExecution && expectedRoot === root) {
    return;
  }
  if (activeExecution && params.postCore) {
    const [previous, current] = await Promise.all([
      resolvePnpmGlobalInstallOwner(expectedRoot),
      resolvePnpmGlobalInstallOwner(root),
    ]);
    if (
      previous &&
      current &&
      previous.ownerRoot === current.ownerRoot &&
      resolveUpdateInstallRoot(current.packageRoot) === root
    ) {
      return;
    }
  }
  throw new Error(
    `Managed update handoff root mismatch: expected ${params.expectedRoot}, running from ${params.root}.`,
  );
}
