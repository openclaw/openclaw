import { afterEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";

export function useWorktreeStateRoots(beforeReset?: () => void, afterClose?: () => void) {
  return useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      beforeReset?.();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      vi.useRealTimers();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      afterClose?.();
      cleanup();
    }),
  );
}
