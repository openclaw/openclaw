import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { buildChannelsTable, mergeChannelsTableWithGatewayStatus } from "./status-all/channels.js";

export const statusScanRuntime = {
  collectChannelStatusIssues,
  buildChannelsTable,
  mergeChannelsTableWithGatewayStatus,
};
