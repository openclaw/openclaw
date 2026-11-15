import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import type {
  ExecutionIdentityAdmissionFacts,
  ExecutionIdentityAdmissionToken,
} from "./execution-identity-admission.js";

type ExecutionDecisionReceiptFacts = Omit<
  DecisionReceiptV1,
  "contextId" | "executionId" | "runId" | "action" | "representedSubject"
> & {
  action: Omit<DecisionReceiptV1["action"], "resourceRef" | "targetRef">;
};

type ExecutionDecisionResourceRef = {
  namespace: "credential-profile";
  value: string;
};

type ExecutionDecisionTargetRef = {
  namespace: "model-route" | "session";
  value: string;
};

export type ExecutionDecisionWork = {
  workVersion: 1;
  token: ExecutionIdentityAdmissionToken;
  receipt: ExecutionDecisionReceiptFacts;
  refs?: {
    representedSubject?: ExecutionIdentityAdmissionFacts["representedSubject"];
    resource?: ExecutionDecisionResourceRef;
    target?: ExecutionDecisionTargetRef;
  };
};
