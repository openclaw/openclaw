export type DurableQuestionRecoveryOwner = {
  questionId: string;
  sourceRunId: string;
  continuationRunId?: string;
  sessionId: string;
  lifecycleRevision: string;
};
