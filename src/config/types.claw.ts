export type ClawConfig = {
  /** Master switch for the experimental Claw mission runtime. Default: false. */
  enabled?: boolean;
  /** Maximum number of concurrently active Claw missions. Default: 1. */
  maxActiveMissions?: number;
  /** Runtime wake loop interval in milliseconds. Default: 5000. */
  loopMs?: number;
  /** Require a fresh-context verifier pass before completion. Default: true. */
  requiredVerifier?: boolean;
  /** Default global autonomy state for newly created control state. Default: true. */
  autonomyDefault?: boolean;
};
