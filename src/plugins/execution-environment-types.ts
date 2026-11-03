import type { OpenClawConfig } from "../config/types.openclaw.js";

/** A consented, host-verified identity; formatting never grants repository authority. */
export type GitCoauthorFormatInputV1 = Readonly<{
  config: OpenClawConfig;
  agentId: string;
  /** Explicit publication realm, when different from the configured default. */
  issuer?: string;
  excludeSubject?: string;
  identity: Readonly<{
    issuer: string;
    subject: string;
    name: string;
    verifiedEmail?: string;
  }>;
}>;
export type FormattedGitCoauthorV1 = Readonly<{ name: string; trailer: string }>;

/** Nonsecret facts prepared by an admitted optional execution owner. */
export type PreparedExecutionEnvironment = Readonly<{
  credentialScrubEnv: Readonly<Record<string, string>>;
  localIdentityEnv: Readonly<Record<string, string>>;
  excludedStoreNames: readonly string[];
  localGitConfigParameters?: string;
  /** Require host-owned tools when the runtime cannot apply the local launch adapter. */
  hostExecutionRequired?: true;
  /** Enclose the exact reviewed argv; credentials remain in the private child resolver. */
  wrapLocalLaunch?: (argv: readonly string[]) => readonly string[];
}>;
export type ExecutionEnvironmentPreparationV1 = Readonly<{
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  agentId: string;
  assertCurrent: () => void;
  signal?: AbortSignal;
}>;
export type SandboxExecutionEnvironmentPreparationV1 = ExecutionEnvironmentPreparationV1 &
  Readonly<{
    backend: string;
    scope: "agent" | "session" | "shared";
  }>;
export type PreparedSandboxExecutionEnvironment = Omit<
  PreparedExecutionEnvironment,
  "localGitConfigParameters" | "hostExecutionRequired" | "excludedStoreNames"
> &
  Readonly<{
    readOnlyResourceMounts: readonly Readonly<{ hostPath: string; containerPath: string }>[];
    inheritedEnvironmentNames: readonly string[];
  }>;
export type ExecutionEnvironmentProviderV1 = {
  id: string;
  /** Pure formatting only: undefined declines this issuer; null deliberately omits this identity. */
  formatGitCoauthor?(
    this: void,
    input: GitCoauthorFormatInputV1,
  ): FormattedGitCoauthorV1 | null | undefined;
  prepare(this: void, input: ExecutionEnvironmentPreparationV1): PreparedExecutionEnvironment;
  prepareSandbox?(
    this: void,
    input: SandboxExecutionEnvironmentPreparationV1,
  ): Promise<PreparedSandboxExecutionEnvironment | undefined>;
};
