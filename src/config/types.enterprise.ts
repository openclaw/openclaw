export type AutonomousEnterpriseConfig = {
  enabled?: boolean;
  approvalGates?: Record<string, boolean>;
  safetyGuards?: {
    payments?: boolean;
    userData?: boolean;
    destructive?: boolean;
    externalApi?: boolean;
  };
};
