import type { UpdateRunResult } from "../../infra/update-runner.js";
import { createWindowsTaskAutoStartGuard } from "./update-command-service-maintenance.js";
import {
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  type PreManagedServiceStop,
} from "./update-command-service.js";

export async function resumeWindowsAutoStartForUpdate(params: {
  result: UpdateRunResult;
  root: string;
  updateStepTimeoutMs: number;
  currentServiceStop: () => PreManagedServiceStop | undefined;
}): Promise<void> {
  const stopped = params.currentServiceStop();
  await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
    stopped,
    true,
    stopped
      ? createWindowsTaskAutoStartGuard({
          root: params.result.root ?? params.root,
          before: stopped,
          timeoutMs: params.updateStepTimeoutMs,
        })
      : undefined,
  );
}
