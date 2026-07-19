import * as contractModule from "@openclaw/contracts";
import type {
  CreateJobRequest,
  ExecutionAcceptedResponse,
  ExecutionCompletedEvent,
  ExecutionFailedEvent,
  JobResponse,
  ProjectResponse,
  ReviewAcceptedResponse,
  ReviewCompletedEvent,
  StartExecutionCommand,
  StartReviewCommand,
} from "@openclaw/contracts";

type ContractValueMap = {
  readonly CreateJobRequest: CreateJobRequest;
  readonly ExecutionAcceptedResponse: ExecutionAcceptedResponse;
  readonly ExecutionCompletedEvent: ExecutionCompletedEvent;
  readonly ExecutionFailedEvent: ExecutionFailedEvent;
  readonly JobResponse: JobResponse;
  readonly ProjectResponse: ProjectResponse;
  readonly ReviewAcceptedResponse: ReviewAcceptedResponse;
  readonly ReviewCompletedEvent: ReviewCompletedEvent;
  readonly StartExecutionCommand: StartExecutionCommand;
  readonly StartReviewCommand: StartReviewCommand;
};

type ContractName = keyof ContractValueMap;

type ContractsRuntime = {
  validate: (
    contractName: ContractName,
    value: unknown,
  ) => { valid: boolean; errors: readonly string[] };
};

const contractsRuntime = contractModule as unknown as ContractsRuntime;

export function assertPlatformContract<Name extends ContractName>(
  contractName: Name,
  value: unknown,
): ContractValueMap[Name] {
  const result = contractsRuntime.validate(contractName, value);
  if (!result.valid) {
    throw new Error(`invalid ${contractName}: ${result.errors.join("; ")}`);
  }
  return value as ContractValueMap[Name];
}
