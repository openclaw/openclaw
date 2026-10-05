import type { GoalRecoveryIntent } from "../config/sessions/main-session-recovery.types.js";

export type DoctorSessionRecoveryTarget = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  placementGeneration: number;
};

export type DoctorSessionRecoveryInput = {
  kind: "doctor-session-recovery";
  database: { agentId: string; path: string };
  statePath: string;
  env: NodeJS.ProcessEnv;
  target: DoctorSessionRecoveryTarget;
};

export type RecoveryIssuerDiagnostic = {
  profileId: string;
  factoryActor: GoalRecoveryIntent["issuer"]["factoryActor"];
  matchesLifecycle: boolean;
};

export type DoctorSessionRecoveryDiagnostic = {
  kind: "doctor-session-recovery";
  diagnosticOnly: true;
  target: DoctorSessionRecoveryTarget;
  agent:
    | { status: "unavailable" | "identity-mismatch" }
    | {
        status: "read";
        sessionStatus: string | null;
        goalId: string | null;
        goalStatus: string | null;
        goalPauseOrigin: string | null;
        archived: boolean;
        restart: {
          pause: boolean;
          acknowledgedPause: boolean;
          tombstone: boolean;
          reservation: boolean;
          startedAttempt: boolean;
          foregroundClaims: boolean;
          turnIssuer: RecoveryIssuerDiagnostic | null;
          goalIssuer: RecoveryIssuerDiagnostic | null;
        };
        effects:
          | { status: "unavailable" }
          | { status: "read"; unresolvedEffect: boolean; unresolvedAcrossTurns: boolean };
        committed:
          | { status: "unavailable" }
          | {
              status: "read";
              current: boolean;
              blocked: boolean;
              // Absent selector flags can mean effects were never evaluated.
              effectHold: boolean | null;
              candidate: { inputId: string; runId: string; profileId: string } | null;
            };
        pending:
          | { status: "unavailable" }
          | {
              status: "read";
              truncated: boolean;
              inputs: Array<{
                inputId: string;
                runId: string;
                state: string;
                lifecycleGeneration: string;
                capture: "absent" | "invalid" | "decoded";
                issuer: RecoveryIssuerDiagnostic | null;
              }>;
            };
      };
  source:
    | { status: "unavailable" | "identity-mismatch" }
    | {
        status: "read";
        state: string;
        environmentId: string | null;
        profileId: string | null;
        providerId: string | null;
        activeOwnerEpoch: number | null;
        turnClaimRunId: string | null;
        neverActivated: boolean;
        environmentGone: boolean;
        destroyedBeforeActivation: boolean;
        environment: {
          state: string;
          ownerEpoch: number;
          leasePresent: boolean;
          recoveryHoldPhase: string | null;
          providerReleaseRecorded: boolean | null;
          cleanupSettlementRecorded: boolean | null;
        } | null;
      };
};
