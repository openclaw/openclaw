import path from "node:path";

export type BackendId = "ollama" | "llama-cpp" | "gemma-cpp";

export const ALL_BACKENDS: readonly BackendId[] = ["ollama", "llama-cpp", "gemma-cpp"] as const;

export type ProvisionProgress = (message: string) => void;

export type RuntimeHandle = {
  pid: number;
  port: number;
  apiBaseUrl: string;
  stop(): Promise<void>;
};

export type RuntimeManager = {
  readonly id: BackendId;
  readonly displayName: string;
  readonly defaultPort: number;
  isInstalled(): Promise<boolean>;
  install(progress?: ProvisionProgress): Promise<void>;
  start(port?: number): Promise<RuntimeHandle>;
  healthcheck(port: number): Promise<boolean>;
  pullModel(modelId: string, port: number, progress?: ProvisionProgress): Promise<void>;
};

export type ProvisionResult = {
  backend: BackendId;
  handle: RuntimeHandle;
  modelId: string;
};

export type ProvisionOpts = {
  backend: BackendId;
  model?: string;
  port?: number;
  skipVerify?: boolean;
  progress?: ProvisionProgress;
};

export function resolveGemmaclawHome(): string {
  return process.env.GEMMACLAW_HOME ?? path.join(process.env.HOME ?? "/tmp", ".gemmaclaw");
}

export function resolveRuntimeDir(backend: BackendId): string {
  return path.join(resolveGemmaclawHome(), "runtimes", backend);
}

export function resolveModelsDir(backend: BackendId): string {
  return path.join(resolveGemmaclawHome(), "models", backend);
}
