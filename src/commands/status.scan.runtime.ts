import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { buildChannelsTable, buildChannelsTableFromGatewayStatus } from "./status-all/channels.js";

export const statusScanRuntime = {
  collectChannelStatusIssues,
  buildChannelsTable,
  buildChannelsTableFromGatewayStatus,
};
