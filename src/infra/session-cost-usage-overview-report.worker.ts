import {
  buildUsageOverviewReport,
  type UsageOverviewReportInput,
} from "./session-cost-usage-overview-report.js";
import { serveWorkerTasks } from "./worker-task-server.js";

// SAFETY: This worker's sole caller is the pool typed with UsageOverviewReportInput.
serveWorkerTasks((input) => buildUsageOverviewReport(input as UsageOverviewReportInput));
