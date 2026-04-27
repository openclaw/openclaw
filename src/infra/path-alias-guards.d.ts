import { type BoundaryPathAliasPolicy } from "./boundary-path.js";
export type PathAliasPolicy = BoundaryPathAliasPolicy;
export declare const PATH_ALIAS_POLICIES: {
    readonly strict: Readonly<{
        allowFinalSymlinkForUnlink: false;
        allowFinalHardlinkForUnlink: false;
    }>;
    readonly unlinkTarget: Readonly<{
        allowFinalSymlinkForUnlink: true;
        allowFinalHardlinkForUnlink: true;
    }>;
};
export declare function assertNoPathAliasEscape(params: {
    absolutePath: string;
    rootPath: string;
    boundaryLabel: string;
    policy?: PathAliasPolicy;
}): Promise<void>;
