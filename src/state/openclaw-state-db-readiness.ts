import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest as closeCachedOpenClawStateDatabaseForTest,
  registerOpenClawStateDatabaseLifecycleListener,
} from "./openclaw-state-db-cache.js";

type OpenClawStateDatabaseReadinessStatus = "active" | "failed" | "inactive";

const readinessByPath = new Map<string, OpenClawStateDatabaseReadinessStatus>();

export function publishOpenClawStateDatabaseReadiness(
  pathname: string,
  status: OpenClawStateDatabaseReadinessStatus,
): void {
  const resolvedPath = path.resolve(pathname);
  if (status === "inactive") {
    readinessByPath.delete(resolvedPath);
    return;
  }
  readinessByPath.set(resolvedPath, status);
}

export function getOpenClawStateDatabaseReadiness(
  pathname: string,
): OpenClawStateDatabaseReadinessStatus {
  return readinessByPath.get(path.resolve(pathname)) ?? "inactive";
}

export function clearOpenClawStateDatabaseReadinessForTest(): void {
  readinessByPath.clear();
}

export function closeOpenClawStateDatabaseForTest(): void {
  closeCachedOpenClawStateDatabaseForTest();
  clearOpenClawStateDatabaseReadinessForTest();
}

registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind === "opened") {
    publishOpenClawStateDatabaseReadiness(event.database.path, "active");
    return;
  }
  publishOpenClawStateDatabaseReadiness(
    event.path,
    event.kind === "closed" ? "inactive" : "failed",
  );
});
