import "vitest";

export type CodexAttemptRuntime = {
  readWorkerPools: typeof import("../../src/infra/worker-cpu.js").getTrackedWorkerPoolSnapshot;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

declare module "vitest" {
  export interface TestContext {
    codexAttemptRuntime?: CodexAttemptRuntime;
  }
}
