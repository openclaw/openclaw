// Kept as a tiny barrel so channel status code is only imported when channel data is requested.

export { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
export { buildChannelsTable } from "./status-all/channels.js";
