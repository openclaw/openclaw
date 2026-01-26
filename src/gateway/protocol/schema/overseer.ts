import { Type } from "@sinclair/typebox";

export const OverseerStatusParamsSchema = Type.Object({
  includeGoals: Type.Optional(Type.Boolean()),
  includeAssignments: Type.Optional(Type.Boolean()),
  includeCrystallizations: Type.Optional(Type.Boolean()),
});

export type OverseerStatusParams = {
  includeGoals?: boolean;
  includeAssignments?: boolean;
  includeCrystallizations?: boolean;
};

export const OverseerGoalSummarySchema = Type.Object({
  goalId: Type.String(),
  title: Type.String(),
  status: Type.String(),
  priority: Type.String(),
  updatedAt: Type.Number(),
  tags: Type.Array(Type.String()),
});

export const OverseerAssignmentSummarySchema = Type.Object({
  assignmentId: Type.String(),
  goalId: Type.String(),
  workNodeId: Type.String(),
  status: Type.String(),
  lastDispatchAt: Type.Optional(Type.Number()),
  lastObservedActivityAt: Type.Optional(Type.Number()),
  retryCount: Type.Optional(Type.Number()),
});

export const OverseerStatusResultSchema = Type.Object({
  ts: Type.Number(),
  goals: Type.Array(OverseerGoalSummarySchema),
  stalledAssignments: Type.Array(OverseerAssignmentSummarySchema),
});

export type OverseerStatusResult = {
  ts: number;
  goals: Array<{
    goalId: string;
    title: string;
    status: string;
    priority: string;
    updatedAt: number;
    tags: string[];
  }>;
  stalledAssignments: Array<{
    assignmentId: string;
    goalId: string;
    workNodeId: string;
    status: string;
    lastDispatchAt?: number;
    lastObservedActivityAt?: number;
    retryCount?: number;
  }>;
};

export const OverseerGoalCreateParamsSchema = Type.Object({
  title: Type.String(),
  problemStatement: Type.String(),
  successCriteria: Type.Optional(Type.Array(Type.String())),
  constraints: Type.Optional(Type.Array(Type.String())),
  nonGoals: Type.Optional(Type.Array(Type.String())),
  priority: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  fromSession: Type.Optional(Type.String()),
  owner: Type.Optional(Type.String()),
  repoContextSnapshot: Type.Optional(Type.String()),
  generatePlan: Type.Optional(Type.Boolean()),
});

export type OverseerGoalCreateParams = {
  title: string;
  problemStatement: string;
  successCriteria?: string[];
  constraints?: string[];
  nonGoals?: string[];
  priority?: string;
  tags?: string[];
  fromSession?: string;
  owner?: string;
  repoContextSnapshot?: string;
  generatePlan?: boolean;
};

export const OverseerGoalCreateResultSchema = Type.Object({
  goalId: Type.String(),
  planGenerated: Type.Boolean(),
});

export type OverseerGoalCreateResult = {
  goalId: string;
  planGenerated: boolean;
};

export const OverseerGoalStatusParamsSchema = Type.Object({
  goalId: Type.String(),
});

export type OverseerGoalStatusParams = {
  goalId: string;
};

export const OverseerGoalUpdateParamsSchema = Type.Object({
  goalId: Type.String(),
  title: Type.Optional(Type.String()),
  problemStatement: Type.Optional(Type.String()),
  successCriteria: Type.Optional(Type.Array(Type.String())),
  constraints: Type.Optional(Type.Array(Type.String())),
});

export type OverseerGoalUpdateParams = {
  goalId: string;
  title?: string;
  problemStatement?: string;
  successCriteria?: string[];
  constraints?: string[];
};

const OverseerPlanNodeBaseFields = {
  id: Type.String(),
  parentId: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  name: Type.String(),
  objective: Type.Optional(Type.String()),
  expectedOutcome: Type.Optional(Type.String()),
  acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
  definitionOfDone: Type.Optional(Type.String()),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  blocks: Type.Optional(Type.Array(Type.String())),
  suggestedAgentId: Type.Optional(Type.String()),
  suggestedAgentType: Type.Optional(Type.String()),
  requiredTools: Type.Optional(Type.Array(Type.String())),
  estimatedEffort: Type.Optional(Type.String()),
  riskLevel: Type.Optional(Type.String()),
  status: Type.String(),
  blockedReason: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  startedAt: Type.Optional(Type.Number()),
  endedAt: Type.Optional(Type.Number()),
};

const OverseerSubtaskSchema = Type.Object(OverseerPlanNodeBaseFields);

const OverseerTaskSchema = Type.Object({
  ...OverseerPlanNodeBaseFields,
  subtasks: Type.Array(OverseerSubtaskSchema),
});

const OverseerPhaseSchema = Type.Object({
  ...OverseerPlanNodeBaseFields,
  tasks: Type.Array(OverseerTaskSchema),
});

const OverseerPlanSchema = Type.Object({
  planVersion: Type.Number(),
  phases: Type.Array(OverseerPhaseSchema),
});

const OverseerGoalDetailSchema = Type.Object({
  goalId: Type.String(),
  title: Type.String(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  status: Type.String(),
  priority: Type.String(),
  tags: Type.Array(Type.String()),
  problemStatement: Type.String(),
  successCriteria: Type.Array(Type.String()),
  nonGoals: Type.Array(Type.String()),
  constraints: Type.Optional(Type.Array(Type.String())),
  owner: Type.Optional(Type.String()),
  stakeholders: Type.Optional(Type.Array(Type.String())),
  repoContextSnapshot: Type.Optional(Type.String()),
  assumptions: Type.Optional(Type.Array(Type.String())),
  risks: Type.Optional(
    Type.Array(
      Type.Object({
        risk: Type.String(),
        impact: Type.Optional(Type.String()),
        mitigation: Type.Optional(Type.String()),
      }),
    ),
  ),
  plan: Type.Optional(OverseerPlanSchema),
});

const OverseerAssignmentDetailSchema = Type.Object({
  assignmentId: Type.String(),
  goalId: Type.String(),
  workNodeId: Type.String(),
  status: Type.String(),
  agentId: Type.Optional(Type.String()),
  sessionKey: Type.Optional(Type.String()),
  runId: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  lastDispatchAt: Type.Optional(Type.Number()),
  lastObservedActivityAt: Type.Optional(Type.Number()),
  expectedNextUpdateAt: Type.Optional(Type.Number()),
  idleAfterMs: Type.Optional(Type.Number()),
  retryCount: Type.Optional(Type.Number()),
  lastRetryAt: Type.Optional(Type.Number()),
  backoffUntil: Type.Optional(Type.Number()),
  recoveryPolicy: Type.Optional(Type.String()),
  blockedReason: Type.Optional(Type.String()),
});

const OverseerCrystallizationSchema = Type.Object({
  crystallizationId: Type.String(),
  goalId: Type.String(),
  workNodeId: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  currentState: Type.Optional(Type.String()),
  decisions: Type.Optional(Type.Array(Type.String())),
  nextActions: Type.Optional(Type.Array(Type.String())),
  openQuestions: Type.Optional(Type.Array(Type.String())),
  knownBlockers: Type.Optional(Type.Array(Type.String())),
  evidence: Type.Optional(
    Type.Object({
      filesTouched: Type.Optional(Type.Array(Type.String())),
      commandsRun: Type.Optional(Type.Array(Type.String())),
      testsRun: Type.Optional(Type.Array(Type.String())),
      commits: Type.Optional(Type.Array(Type.String())),
      prs: Type.Optional(Type.Array(Type.String())),
      issues: Type.Optional(Type.Array(Type.String())),
      externalRefs: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  createdAt: Type.Number(),
});

const OverseerEventSchema = Type.Object({
  ts: Type.Number(),
  type: Type.String(),
  goalId: Type.Optional(Type.String()),
  assignmentId: Type.Optional(Type.String()),
  workNodeId: Type.Optional(Type.String()),
});

export const OverseerGoalStatusResultSchema = Type.Object({
  ts: Type.Number(),
  goal: Type.Optional(OverseerGoalDetailSchema),
  assignments: Type.Array(OverseerAssignmentDetailSchema),
  crystallizations: Type.Array(OverseerCrystallizationSchema),
  events: Type.Array(OverseerEventSchema),
});

export type OverseerGoalStatusResult = {
  ts: number;
  goal?: {
    goalId: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    status: string;
    priority: string;
    tags: string[];
    problemStatement: string;
    successCriteria: string[];
    nonGoals: string[];
    constraints?: string[];
    owner?: string;
    stakeholders?: string[];
    repoContextSnapshot?: string;
    assumptions?: string[];
    risks?: Array<{
      risk: string;
      impact?: string;
      mitigation?: string;
    }>;
    plan?: {
      planVersion: number;
      phases: Array<{
        id: string;
        parentId?: string;
        path?: string;
        name: string;
        objective?: string;
        expectedOutcome?: string;
        acceptanceCriteria?: string[];
        definitionOfDone?: string;
        dependsOn?: string[];
        blocks?: string[];
        suggestedAgentId?: string;
        suggestedAgentType?: string;
        requiredTools?: string[];
        estimatedEffort?: string;
        riskLevel?: string;
        status: string;
        blockedReason?: string;
        createdAt: number;
        updatedAt: number;
        startedAt?: number;
        endedAt?: number;
        tasks: Array<{
          id: string;
          parentId?: string;
          path?: string;
          name: string;
          objective?: string;
          expectedOutcome?: string;
          acceptanceCriteria?: string[];
          definitionOfDone?: string;
          dependsOn?: string[];
          blocks?: string[];
          suggestedAgentId?: string;
          suggestedAgentType?: string;
          requiredTools?: string[];
          estimatedEffort?: string;
          riskLevel?: string;
          status: string;
          blockedReason?: string;
          createdAt: number;
          updatedAt: number;
          startedAt?: number;
          endedAt?: number;
          subtasks: Array<{
            id: string;
            parentId?: string;
            path?: string;
            name: string;
            objective?: string;
            expectedOutcome?: string;
            acceptanceCriteria?: string[];
            definitionOfDone?: string;
            dependsOn?: string[];
            blocks?: string[];
            suggestedAgentId?: string;
            suggestedAgentType?: string;
            requiredTools?: string[];
            estimatedEffort?: string;
            riskLevel?: string;
            status: string;
            blockedReason?: string;
            createdAt: number;
            updatedAt: number;
            startedAt?: number;
            endedAt?: number;
          }>;
        }>;
      }>;
    };
  };
  assignments: Array<{
    assignmentId: string;
    goalId: string;
    workNodeId: string;
    status: string;
    agentId?: string;
    sessionKey?: string;
    runId?: string;
    createdAt: number;
    updatedAt: number;
    lastDispatchAt?: number;
    lastObservedActivityAt?: number;
    expectedNextUpdateAt?: number;
    idleAfterMs?: number;
    retryCount?: number;
    lastRetryAt?: number;
    backoffUntil?: number;
    recoveryPolicy?: string;
    blockedReason?: string;
  }>;
  crystallizations: Array<{
    crystallizationId: string;
    goalId: string;
    workNodeId?: string;
    summary?: string;
    currentState?: string;
    decisions?: string[];
    nextActions?: string[];
    openQuestions?: string[];
    knownBlockers?: string[];
    evidence?: {
      filesTouched?: string[];
      commandsRun?: string[];
      testsRun?: string[];
      commits?: string[];
      prs?: string[];
      issues?: string[];
      externalRefs?: string[];
    };
    createdAt: number;
  }>;
  events: Array<{
    ts: number;
    type: string;
    goalId?: string;
    assignmentId?: string;
    workNodeId?: string;
  }>;
};

export const OverseerWorkUpdateParamsSchema = Type.Object({
  goalId: Type.String(),
  workNodeId: Type.String(),
  status: Type.Optional(Type.String()),
  blockedReason: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  evidence: Type.Optional(
    Type.Object({
      filesTouched: Type.Optional(Type.Array(Type.String())),
      commandsRun: Type.Optional(Type.Array(Type.String())),
      testsRun: Type.Optional(Type.Array(Type.String())),
      commits: Type.Optional(Type.Array(Type.String())),
      prs: Type.Optional(Type.Array(Type.String())),
      issues: Type.Optional(Type.Array(Type.String())),
      externalRefs: Type.Optional(Type.Array(Type.String())),
    }),
  ),
});

export type OverseerWorkUpdateParams = {
  goalId: string;
  workNodeId: string;
  status?: string;
  blockedReason?: string;
  summary?: string;
  evidence?: {
    filesTouched?: string[];
    commandsRun?: string[];
    testsRun?: string[];
    commits?: string[];
    prs?: string[];
    issues?: string[];
    externalRefs?: string[];
  };
};

export const OverseerTickParamsSchema = Type.Object({
  reason: Type.Optional(Type.String()),
});

export type OverseerTickParams = {
  reason?: string;
};
