import { readPackageVersion } from "../../infra/package-json.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";

export async function readPackageUpdateIdentity(root: string) {
  const [version, buildId] = await Promise.all([
    readPackageVersion(root),
    readBuiltGatewayBuildId(root),
  ]);
  return { version, ...(buildId ? { buildId } : {}) };
}
