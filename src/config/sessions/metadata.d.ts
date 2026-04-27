import type { MsgContext } from "../../auto-reply/templating.js";
import type { GroupKeyResolution, SessionEntry, SessionOrigin } from "./types.js";
export declare function deriveSessionOrigin(ctx: MsgContext, opts?: {
    skipSystemEventOrigin?: boolean;
}): SessionOrigin | undefined;
export declare function snapshotSessionOrigin(entry?: SessionEntry): SessionOrigin | undefined;
export declare function deriveGroupSessionPatch(params: {
    ctx: MsgContext;
    sessionKey: string;
    existing?: SessionEntry;
    groupResolution?: GroupKeyResolution | null;
}): Partial<SessionEntry> | null;
export declare function deriveSessionMetaPatch(params: {
    ctx: MsgContext;
    sessionKey: string;
    existing?: SessionEntry;
    groupResolution?: GroupKeyResolution | null;
    skipSystemEventOrigin?: boolean;
}): Partial<SessionEntry> | null;
