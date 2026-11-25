import type { VerifiedGitUpdateReceipt } from "./restart-sentinel.js";
import type { UpdateCheckResult } from "./update-check.js";

export type StartupInstallStatus = {
  root: string | null;
  status: UpdateCheckResult;
  installReceipt: VerifiedGitUpdateReceipt | null;
};
