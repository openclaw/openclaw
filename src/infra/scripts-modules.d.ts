declare module "../../scripts/watch-node.mjs" {
  export function runWatchMain(params?: {
    spawn?: (
      cmd: string,
      args: string[],
      options: unknown,
    ) => { on: (event: "exit", cb: (code: number | null, signal: string | null) => void) => void };
    process?: NodeJS.Process;
    cwd?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    now?: () => number;
  }): Promise<number>;
}

declare module "../../scripts/ci-changed-scope.mjs" {
  export function detectChangedScope(paths: string[]): {
    runNode: boolean;
    runMacos: boolean;
    runAndroid: boolean;
  };
}

declare module "../../scripts/lib/test-parallel-policy.mjs" {
  export function shouldEnableTopLevelParallel(params?: {
    isCI?: boolean;
    testProfile?: string;
  }): boolean;
  export function resolveVitestPoolForWorkerClamp(params: {
    pool: string;
    maxWorkers: number;
  }): string;
}

declare module "*test-parallel-policy.mjs" {
  export function shouldEnableTopLevelParallel(params?: {
    isCI?: boolean;
    testProfile?: string;
  }): boolean;
  export function resolveVitestPoolForWorkerClamp(params: {
    pool: string;
    maxWorkers: number;
  }): string;
}
