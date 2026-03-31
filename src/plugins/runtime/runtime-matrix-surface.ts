import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";

export type MatrixThreadBindingIdleTimeoutParams = {
  accountId: string;
  targetSessionKey: string;
  idleTimeoutMs: number;
};

export type MatrixThreadBindingMaxAgeParams = {
  accountId: string;
  targetSessionKey: string;
  maxAgeMs: number;
};

export type MatrixRuntimeBoundaryModule = {
  setMatrixThreadBindingIdleTimeoutBySessionKey: (
    params: MatrixThreadBindingIdleTimeoutParams,
  ) => SessionBindingRecord[];
  setMatrixThreadBindingMaxAgeBySessionKey: (
    params: MatrixThreadBindingMaxAgeParams,
  ) => SessionBindingRecord[];
};
