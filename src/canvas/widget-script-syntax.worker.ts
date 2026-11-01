import { serveWorkerTasks } from "../infra/worker-task-server.js";
import { parseWidgetScript, type WidgetScript } from "./widget-script-parse.js";

serveWorkerTasks<ReturnType<typeof parseWidgetScript>, WidgetScript>(parseWidgetScript);
