import "vitest";

declare module "vitest" {
  export interface TestContext {
    codexAttemptRuntime?: {
      start: () => Promise<void>;
      stop: () => Promise<void>;
    };
  }
}
