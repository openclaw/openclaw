import "vitest";

declare module "vitest" {
  export interface TestContext {
    codexAttemptRuntime?: {
      readWorkerPools: typeof import("../../src/infra/worker-cpu.js").getTrackedWorkerPoolSnapshot;
      start: () => Promise<void>;
      stop: () => Promise<void>;
    };
  }
}
