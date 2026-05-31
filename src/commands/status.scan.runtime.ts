import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { buildChannelsTable } from "./status-all/channels.js";

/** Runtime hooks used by status scan overview code for channel-specific data. */
export const statusScanRuntime = {
  collectChannelStatusIssues,
  buildChannelsTable,
};
