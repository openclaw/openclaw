import path from "node:path";
import { isForegroundGatewayRunArgv } from "../gateway-run-argv.mjs";
import { isLocalRootVersionInvocation } from "./entry.version-fast-path.js";
import { packageReleasePrefixOfRoot } from "./infra/package-release-slot-path.js";

/** The entry's module root, not argv, identifies the code this process can still import. */
export async function holdCliReleaseUntilExit(root: string): Promise<void> {
  const release = packageReleasePrefixOfRoot(root);
  if (
    !release ||
    path.basename(release).startsWith(".") ||
    isForegroundGatewayRunArgv(process.argv) ||
    isLocalRootVersionInvocation(process.argv)
  ) {
    // Preparation and the serving Gateway have their own holders. Version only prints metadata.
    return;
  }
  const { acquirePackageReleaseLease } = await import("./infra/package-release-lease.js");
  let releaseLease: () => void;
  try {
    releaseLease = acquirePackageReleaseLease(root, path.dirname(path.dirname(release)));
  } catch (cause) {
    throw new Error(
      `Cannot protect the running OpenClaw release at ${root} from update cleanup. Run this command as the installation owner, or use a separately installed copy.`,
      { cause },
    );
  }
  process.once("exit", () => {
    try {
      releaseLease();
    } catch {
      // A dead process's lease is ignored. Preserve the command's actual exit status.
    }
  });
}
