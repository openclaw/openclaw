import type { Command } from "commander";
import { validateExecApprovalsNativeRequest } from "../../packages/gateway-protocol/src/index.js";
import { parsePersistedExecApprovals } from "../infra/exec-approvals-config.js";
import { defaultRuntime } from "../runtime.js";
import { formatCliError, readStdin } from "./exec-approvals-cli.shared.js";
import {
  commitNativeExecLocal,
  loadSnapshotLocal,
  saveSnapshotLocal,
} from "./exec-approvals-local.js";
import { throwExpectedCliError } from "./expected-cli-error.js";
import { rethrowExpectedCliError } from "./failure-output.js";

export function registerNativeExecApprovalsCli(approvals: Command): void {
  approvals
    .command("native", { hidden: true })
    .description("Internal native approval owner transport")
    .requiredOption("--stdin", "Read one bounded native owner operation as JSON")
    .option("--json", "Keep the native result on stdout and diagnostics on stderr", true)
    .action(async () => {
      try {
        const input: unknown = JSON.parse(await readStdin());
        if (!validateExecApprovalsNativeRequest(input)) {
          throw new Error("Invalid native exec approval owner request.");
        }
        let result;
        if (input.operation === "get") {
          result = await loadSnapshotLocal();
        } else if (input.operation === "set") {
          const policy = parsePersistedExecApprovals(JSON.stringify(input.file));
          if (!policy.ok) {
            throw new Error(`Invalid native exec approval policy: ${policy.error}`);
          }
          result = await saveSnapshotLocal(policy.value, input.baseHash);
        } else {
          const { operation: _operation, ...authorization } = input;
          result = await commitNativeExecLocal(authorization);
        }
        defaultRuntime.writeJson(result, 0);
      } catch (error) {
        rethrowExpectedCliError(error);
        throwExpectedCliError(formatCliError(error));
      }
    });
}
