import { serveWorkerTasks } from "../infra/worker-task-server.js";
import { ownedWorkerBytes } from "../infra/worker-transfer-bytes.js";
import { scanWorkspaceIcon, type WorkspaceIconSnapshot } from "./workspace-icon-scan.js";

serveWorkerTasks<WorkspaceIconSnapshot | null, string>(
  async (workspaceRoot) => {
    const icon = await scanWorkspaceIcon(workspaceRoot);
    return icon && { ...icon, body: ownedWorkerBytes(icon.body) };
  },
  { transferList: (icon) => (icon ? [icon.body.buffer] : []) },
);
