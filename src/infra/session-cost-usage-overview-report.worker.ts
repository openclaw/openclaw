import {
  runUsageOverviewTask,
  type UsageOverviewTask,
} from "./session-cost-usage-overview-report.js";
import { serveWorkerTasks } from "./worker-task-server.js";

// SAFETY: This worker's sole caller is the pool typed with UsageOverviewTask.
serveWorkerTasks((input) => runUsageOverviewTask(input as UsageOverviewTask));
