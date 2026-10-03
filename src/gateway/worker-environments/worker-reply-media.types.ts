import type { ReplyPayload } from "../../shared/reply-payload.types.js";

export type WorkerReplyMediaPreparer = (payload: ReplyPayload) => Promise<ReplyPayload>;
