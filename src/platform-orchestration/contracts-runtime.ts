import * as contractModule from "@openclaw/contracts";

type ContractName =
  | "CreateJobRequest"
  | "ExecutionAcceptedResponse"
  | "ExecutionCompletedEvent"
  | "ExecutionFailedEvent"
  | "JobResponse"
  | "ProjectResponse"
  | "ReviewAcceptedResponse"
  | "ReviewCompletedEvent"
  | "StartExecutionCommand"
  | "StartReviewCommand";

type ContractsRuntime = {
  validate: (
    contractName: ContractName,
    value: unknown,
  ) => { valid: boolean; errors: readonly string[] };
};

const contractsRuntime = contractModule as unknown as ContractsRuntime;

export function assertPlatformContract<T>(contractName: ContractName, value: unknown): T {
  const result = contractsRuntime.validate(contractName, value);
  if (!result.valid) {
    throw new Error(`invalid ${contractName}: ${result.errors.join("; ")}`);
  }
  return value as T;
}
