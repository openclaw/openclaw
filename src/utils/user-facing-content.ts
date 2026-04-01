import {
  assertUserVisibleDeferredDisplayPayload,
  type DeferredDisplayPayload,
} from "./deferred-visibility.js";

export type UserFacingContentSource =
  | "direct-agent-output"
  | "queued-followup-display"
  | "queued-announce-display"
  | "summary-renderer";

export type UserFacingContent = {
  visibility: "user-visible";
  text?: string;
  summaryLine?: string;
  source: UserFacingContentSource;
};

export function toUserFacingContent(params: {
  payload: DeferredDisplayPayload | undefined;
  source: UserFacingContentSource;
}): UserFacingContent {
  const payload = assertUserVisibleDeferredDisplayPayload(params.payload);
  return {
    visibility: "user-visible",
    text: payload.text,
    summaryLine: payload.summaryLine,
    source: params.source,
  };
}
