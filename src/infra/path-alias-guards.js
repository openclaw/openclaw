import { BOUNDARY_PATH_ALIAS_POLICIES, resolveBoundaryPath, } from "./boundary-path.js";
import { assertNoHardlinkedFinalPath } from "./hardlink-guards.js";
export const PATH_ALIAS_POLICIES = BOUNDARY_PATH_ALIAS_POLICIES;
export async function assertNoPathAliasEscape(params) {
    const resolved = await resolveBoundaryPath({
        absolutePath: params.absolutePath,
        rootPath: params.rootPath,
        boundaryLabel: params.boundaryLabel,
        policy: params.policy,
    });
    const allowFinalSymlink = params.policy?.allowFinalSymlinkForUnlink === true;
    if (allowFinalSymlink && resolved.kind === "symlink") {
        return;
    }
    await assertNoHardlinkedFinalPath({
        filePath: resolved.absolutePath,
        root: resolved.rootPath,
        boundaryLabel: params.boundaryLabel,
        allowFinalHardlinkForUnlink: params.policy?.allowFinalHardlinkForUnlink,
    });
}
