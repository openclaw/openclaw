import type { killSubagentRunAdmin } from "../agents/subagents/registry/subagent-control.js";
import type {
  SubagentAdminKillParams,
  SubagentAdminKillResult,
} from "./task-registry-control.types.js";

export function createSubagentAdminKillMock(
  run: (params: SubagentAdminKillParams) => Promise<SubagentAdminKillResult>,
): typeof killSubagentRunAdmin {
  return async (params, control) => {
    const result = await run(params);
    params.onResult?.(result);
    await control?.settleResult?.(result, control.assertCurrent);
    return result;
  };
}
