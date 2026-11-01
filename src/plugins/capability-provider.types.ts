import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type {
  WorkerExecutionMode,
  WorkerMachineOption as ProtocolWorkerMachineOption,
  WorkerOperatingSystem as ProtocolWorkerOperatingSystem,
  WorkerEnvironmentStartStatus,
} from "../../packages/gateway-protocol/src/schema/environments.js";
import type { SecretRef } from "../config/types.secrets.js";
import type { ImageGenerationProvider } from "../image-generation/types.js";
import type { MediaUnderstandingProvider } from "../media-understanding/types.js";
import type { MusicGenerationProvider } from "../music-generation/types.js";
import type { SpawnResult } from "../process/exec.js";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderConfiguredContext,
  RealtimeTranscriptionProviderId,
  RealtimeTranscriptionProviderResolveConfigContext,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "../realtime-transcription/provider-types.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderCapabilities,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderConfiguredContext,
  RealtimeVoiceProviderId,
  RealtimeVoiceProviderResolveConfigContext,
} from "../talk/provider-types.js";
import type { TranscriptSourceProvider as TranscriptsSourceProviderCapability } from "../transcripts/provider-types.js";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechProviderConfiguredContext,
  SpeechProviderConfig,
  SpeechProviderResolveConfigContext,
  SpeechProviderResolveTalkConfigContext,
  SpeechProviderResolveTalkOverridesContext,
  SpeechListVoicesRequest,
  SpeechProviderPrepareSynthesisContext,
  SpeechProviderPreparedSynthesis,
  SpeechProviderId,
  SpeechSynthesisRequest,
  SpeechSynthesisStreamRequest,
  SpeechTelephonySynthesisRequest,
  SpeechVoiceOption,
} from "../tts/provider-types.js";
import type {
  SpeechSynthesisResult,
  SpeechSynthesisStreamResult,
  SpeechTelephonySynthesisResult,
} from "../tts/tts-runtime-types.js";
import type { VideoGenerationProvider } from "../video-generation/types.js";
import type { PluginJsonValue } from "./host-hook-json.js";
import type {
  WorkerRetentionObservation,
  WorkerRetentionOperation,
  WorkerRetentionPolicy,
} from "./worker-retention.types.js";

export type {
  WorkerRetentionObservation,
  WorkerRetentionOperation,
  WorkerRetentionPolicy,
} from "./worker-retention.types.js";

export type WorkerProfile = Readonly<Record<string, PluginJsonValue>>;

/** Provider-authored picker metadata for one machine class or exact machine type. */
export type WorkerMachineOption = Readonly<SchemaContract<ProtocolWorkerMachineOption>>;

/**
 * Provider-owned operating system choices for one configured worker profile.
 * disabledReason explains why a target cannot currently be selected, including a repair hint.
 */
export type WorkerOperatingSystem = Readonly<SchemaContract<ProtocolWorkerOperatingSystem>>;

/** SSH endpoint material returned by a worker provider after provisioning. */
export type WorkerSshEndpoint = {
  host: string;
  port: number;
  /**
   * Up to 10 ordered unique integer ports (1..65535) after `port`; excludes the primary.
   * Core rotates only for idempotent probes, content-addressed transfers, receipt/lock-guarded
   * artifact installation, convergent managed-worktree mirroring, and tunnel reconnects.
   * Ambiguous unguarded stateful commands fail closed and are not replayed.
   */
  fallbackPorts?: readonly number[];
  user: string;
  /** OpenSSH public host-key line obtained from trusted provisioning output. */
  hostKey: string;
  /** Secret reference only; providers must never return plaintext key material. */
  keyRef: SecretRef;
};

/** Resolved SSH client identity. Providers may return a local path or ephemeral material. */
export type WorkerSshIdentity =
  | { kind: "path"; path: string }
  | { kind: "material"; contents: string };

/** Durable context supplied when a worker provider resolves the identity it minted. */
export type WorkerSshIdentityRequest = {
  /** Optional live invocation guard; core supplies it for identity resolution. */
  assertCurrent?: () => void;
  leaseId: string;
  profile: WorkerProfile;
  keyRef: SecretRef;
};

/** Closed set of applications installed and launchable on a provisioned worker desktop. */
export type WorkerDesktopApp =
  | {
      id: "browser";
      executablePath: string;
      /** Fixed provider-owned arguments, passed directly without a shell. */
      args?: string[];
      cdpPort: number;
    }
  | { id: "terminal"; executablePath: string; args?: string[] };

/** Optional interactive desktop endpoint provisioned with the lease (warm-time capability). */
export type WorkerDesktopEndpoint = {
  /** Desktop service protocol on the worker loopback; "rfb" is the only phase-1 value. */
  protocol: "rfb";
  /** Loopback port on the worker (e.g. 5900). */
  port: number;
  /** Absolute on-box path to the per-lease password file; read by the owning transport, never persisted as plaintext. */
  passwordFilePath?: string;
  /** Managed desktop account for ARD authentication; its password stays in passwordFilePath. */
  username?: string;
  /** False restricts a native desktop from the provider-wide virtual display resize capability. */
  allowsResize?: boolean;
  /** Closed application metadata advertised by the provider for this desktop. */
  apps?: WorkerDesktopApp[];
};

export type { WorkerExecutionMode } from "../../packages/gateway-protocol/src/schema/environments.js";

/** Grant-free identity of the runtime bytes a provider may retain in a prepared image. */
export type WorkerNodeRuntimeIdentity = {
  nodeBootstrapSha256: string;
  executionMode: WorkerExecutionMode;
  /** Present only when project preparation retains the independent worker archive. */
  workerBundleSha256?: string;
};

type WorkerNodeBootstrapAccess = {
  /** Core-owned command window for downloading and installing this grant's artifacts. */
  bootstrapTimeoutMs?: number;
  /** Immutable node distribution prepared by the Gateway for this provision operation. */
  nodeBootstrap: {
    url: string;
    token: string;
    sha256: string;
    bytes: number;
    openclawVersion: string;
    /** Explicit npm profiles resolve dependencies on the destination; bundles carry them. */
    install?: "bundle" | "npm";
    buildId?: string;
    manifestSha256?: string;
    enabledPluginIds: readonly string[];
    tlsFingerprint?: string;
    /** Core-owned POSIX prerequisite script, applied only to Linux before invoking Node. */
    linuxToolchainSetup?: string;
    /** Optional npm project lock for this exact archive; failure must retain unlocked installation. */
    installLock?: {
      url: string;
      token: string;
      sha256: string;
      bytes: number;
      tlsFingerprint?: string;
    };
  };
  /** Runtime/enrollment closure, including shutdown; stop this work while preserving its allocation. */
  signal?: AbortSignal;
};

/** Operation-bound immutable artifacts without a node identity or enrollment credential. */
export type WorkerNodeRuntimePreparation = WorkerNodeBootstrapAccess & {
  workerBundle: {
    url: string;
    token: string;
    sha256: string;
    bytes: number;
    tlsFingerprint?: string;
    /** Core-owned location within the installed node package, outside dist and enrollment state. */
    packageRelativePath: string;
  };
};

/** Replay-safe node enrollment prepared only after a provider has allocated its machine. */
export type WorkerNodeEnrollment = WorkerNodeBootstrapAccess & {
  openclawVersion: string;
  displayName: string;
  waitForDeviceId: () => Promise<string>;
  /** Private per-lease inference inputs. Never captured in a prepared image. */
  workerCodex?: {
    configToml: string;
    helperScript: string;
    /** Original executable path referenced by configToml; provider rewrites it when staging. */
    helperPath: string;
    configVersion: string;
  };
} & (
    | { mode: "connect"; setupCode: string; setupId: string }
    | { mode: "resume"; deviceId: string }
  );

/** Nonsecret immutable provider identity. The provider owns the identity keys and their meaning. */
export type WorkerResourceReceipt = {
  version: 1;
  leaseId: string;
  identity: Record<string, string>;
};

/** Durable lease identity and endpoint returned by a successful provision operation. */
export type WorkerLease = {
  leaseId: string;
  resourceReceipt?: WorkerResourceReceipt;
  /** The SSH account also owns processes unrelated to this worker lease. */
  sharedHost?: boolean;
  desktop?: WorkerDesktopEndpoint;
} & ({ ssh: WorkerSshEndpoint; node?: never } | { node: { deviceId: string }; ssh?: never });

/** Authoritative inspection result for an already-known worker lease. */
export type WorkerLeaseStatus = {
  resourceReceipt?: WorkerResourceReceipt;
  retention?: WorkerRetentionObservation;
} & (
  | {
      status: "active";
      /** Explicit provider fact used to reconcile leases persisted before this metadata existed. */
      sharedHost?: boolean;
    }
  | { status: "dormant" }
  | { status: "destroyed" }
  | { status: "unknown" }
);

/** Provision failed after allocation and the provider could not prove cleanup completed. */
class WorkerProvisionCleanupError extends AggregateError {
  readonly code = "cleanup_indeterminate";
  readonly leaseId: string;

  constructor(
    leaseId: string,
    readonly provisionError: unknown,
    readonly cleanupError: unknown,
  ) {
    super(
      [provisionError, cleanupError],
      "Worker provision failed after allocation and cleanup is indeterminate",
      { cause: provisionError },
    );
    this.name = "WorkerProvisionCleanupError";
    this.leaseId = leaseId.trim();
    if (!this.leaseId) {
      throw new TypeError("Worker provision cleanup lease id must be non-empty");
    }
  }
}

/** Provision failed after allocation and the provider confirmed cleanup completed. */
class WorkerProvisionCleanupCompleteError extends Error {
  readonly code = "cleanup_complete";
  readonly leaseId: string;

  constructor(
    leaseId: string,
    readonly provisionError: unknown,
  ) {
    super(provisionError instanceof Error ? provisionError.message : String(provisionError), {
      cause: provisionError,
    });
    this.name = "WorkerProvisionCleanupCompleteError";
    this.leaseId = leaseId.trim();
    if (!this.leaseId) {
      throw new TypeError("Worker provision cleanup lease id must be non-empty");
    }
  }
}

/** Permanent provider rejection recorded as a terminal worker failure. */
export class WorkerProviderError extends Error {
  readonly code = "invalid_profile";

  constructor(message: string) {
    super(message);
    this.name = "WorkerProviderError";
  }

  static cleanupComplete(
    leaseId: string,
    provisionError: unknown,
  ): WorkerProvisionCleanupCompleteError {
    return new WorkerProvisionCleanupCompleteError(leaseId, provisionError);
  }

  static isCleanupComplete(error: unknown): error is WorkerProvisionCleanupCompleteError {
    return error instanceof WorkerProvisionCleanupCompleteError;
  }

  static cleanupIndeterminate(
    leaseId: string,
    provisionError: unknown,
    cleanupError: unknown,
  ): WorkerProvisionCleanupError {
    return new WorkerProvisionCleanupError(leaseId, provisionError, cleanupError);
  }

  static isCleanupIndeterminate(error: unknown): error is WorkerProvisionCleanupError {
    return error instanceof WorkerProvisionCleanupError;
  }
}

export type WorkerRecipePreparation = {
  source: "devcontainer" | "script" | "detected" | "none";
  ignoredPropertiesNote?: string;
  note?: string;
  phaseDurationsMs?: {
    onCreate?: number;
    updateContent?: number;
    detectedInstall?: number;
  };
  failure?: { reason: string; outputTail?: string };
};

/** Cloud-worker lifecycle capability shared by plugin and internal providers. */
export type WorkerProvider = {
  id: string;
  /** Honors exact receipts during provision replay, inspection and confirmed destruction. */
  supportsResourceReceipts?: true;
  /**
   * Nonsecret backend display ID, never a routing or allocation identity.
   * Synchronous local presentation only: no commands, network, or credential reads.
   * Return 1–64 lowercase ASCII letters/digits/hyphens, starting with a letter.
   * Omission, invalid values, and exceptions retain generic provider presentation.
   */
  resolveDisplayId?: (profile: WorkerProfile) => string | undefined;
  /** Safe to request virtual desktop resizing; the RFB server still negotiates support. */
  allowsDesktopResize?: boolean;
  /** Process-stable choices available for this profile; omit the hook to hide machine selection. */
  listMachineOptions?: (profile: WorkerProfile) => Promise<readonly WorkerMachineOption[]>;
  listOperatingSystems?: (profile: WorkerProfile) => Promise<readonly WorkerOperatingSystem[]>;
  /** Omission advertises no placement support; multiple modes use their canonical order. */
  supportedExecutionModes?:
    | readonly [WorkerExecutionMode]
    | readonly ["worker-turn", "remote-exec"];
  /**
   * Provision before preparing an installation when the lease transport decides whether an
   * installation is needed. Defaults to false so SSH providers retain prepare-before-allocation.
   */
  provisionBeforeInstallation?: boolean;
  /** Provider allocates a node host through the environment-owned enrollment callback. */
  requiresNodeEnrollment?: boolean;
  /** Prepare a pristine project before enrollment so it can be included in a reusable image. */
  supportsProjectPreparation?: (
    profile: WorkerProfile,
    machineClass?: string,
    os?: string,
  ) => boolean;
  /** Immutable target resolved before project preparation or allocation. */
  resolvePreparationTarget?: (
    profile: WorkerProfile,
    machineClass?: string,
    os?: string,
  ) =>
    | {
        machineClass: string;
        platform: string;
        arch?: string;
        /** SHA-256 of provider-owned disk/boot settings, excluding runtime and lease policy. */
        profileKey?: string;
      }
    | undefined;
  /** Maximum unused ready-worker lifetime, measured from the original session demand. */
  resolvePreparedIdleTimeoutMs?: (profile: WorkerProfile) => number | undefined;
  /** Record successful demand in metadata only; must not allocate, capture, or renew reserves. */
  notePreparedDemand?: (
    lease: { leaseId: string; profile: WorkerProfile },
    demand: { preparationKey: string; demandAtMs: number },
  ) => Promise<void>;
  /**
   * Resolve the exact cleanup handle for this operation, even if no machine was created.
   * Must not provision, start, renew, run setup, enroll, or wait for transport readiness.
   * Identity is not existence/readiness proof; destroy still owns teardown confirmation.
   */
  resolveAllocation: (
    profile: WorkerProfile,
    operationId: string,
  ) => Promise<{ leaseId: string; sharedHost: boolean }>;
  /**
   * Provision or adopt the lease for this operation id.
   * Repeating the same operation id must be idempotent across gateway restarts.
   */
  provision: (
    profile: WorkerProfile,
    operationId: string,
    options?: {
      /** Configured profile id for display; settings and operation id own allocation identity. */
      profileId?: string;
      /** Attempt-scoped display facts; the host rejects reports after provisioning closes. */
      reportStartStatus?: (status: WorkerEnvironmentStartStatus) => void;
      /**
       * Stop this attempt, including on Gateway shutdown; settle active commands before rejecting.
       * Preserve allocations on abort. Explicit cancellation/destroy requests record destruction intent separately.
       */
      signal?: AbortSignal;
      /** Modern hosts supply authority; legacy optionality is source compatibility only. */
      assertCurrent?: () => void;
      /** Original committed resource on replay; never adopt a replacement. */
      resourceReceipt?: WorkerResourceReceipt;
      /** Immutable acquisition policy; activity and inspection never extend compute. */
      retention?: WorkerRetentionPolicy;
      /** Await before setup/enrollment or cleanup affects a newly identified resource. */
      recordResourceReceipt?: (receipt: WorkerResourceReceipt) => Promise<void>;
      executionMode?: WorkerExecutionMode;
      machineClass?: string;
      os?: string;
      nodeRuntimeIdentity?: WorkerNodeRuntimeIdentity;
      /** Upper bound per runtime preparation/enrollment phase, including the node connection wait. */
      nodeBootstrapTimeoutMs?: number;
      prepareNodeRuntime?: () => Promise<WorkerNodeRuntimePreparation>;
      beginNodeEnrollment?: () => Promise<WorkerNodeEnrollment>;
      project?: {
        key: string;
        baseCommit: string;
        label?: string;
        /** Gateway-local checkout root for display and explicit rebuild requests. */
        root?: string;
        preparation?: {
          key: string;
          cacheKey: string;
          purpose: "session" | "reserve";
          demandAtMs: number;
        };
        secretNames?: readonly string[];
        signal: AbortSignal;
        assertCurrent: () => void;
        /** Verify an already enrolled allocation without transferring, running setup, or capturing it. */
        inspectPreparedWorkspace?: (transport: {
          runScript: (script: string, signal: AbortSignal) => Promise<string>;
        }) => Promise<void>;
        /** Bound to this provision attempt; retained callbacks reject after it closes. */
        prepare: (transport: {
          runScript: (script: string, signal: AbortSignal) => Promise<string>;
          /** Render using this provider command's remaining budget before repository code runs. */
          runScriptWithBudget?: (
            createScript: (timeoutMs: number, setupEnv?: Record<string, string>) => string,
            signal: AbortSignal,
          ) => Promise<string>;
          upload: (localPath: string, remotePath: string, signal: AbortSignal) => Promise<void>;
          /** Persist diagnostics before a declared recipe rejects preparation. */
          recordRecipePreparation?: (value: WorkerRecipePreparation) => Promise<void>;
        }) => Promise<{
          seedKey: string;
          cacheHit: boolean;
          /** New completed setup must enter the reusable image before enrollment. */
          captureRequired?: true;
          /** Detected setup is best effort; this allocation must remain cold on failure. */
          captureSkipped?: string;
          recipePreparation?: WorkerRecipePreparation;
          preparedWorkspace?: {
            preparationKey: string;
            cacheKey: string;
            workspaceDir: string;
            homeDir: string;
            sourceManifestRef: string;
            preparedManifestRef: string;
          };
        }>;
      };
    },
  ) => Promise<WorkerLease>;
  /** Provider-owned transport for repository lifecycle commands on an enrolled lease. */
  runSetupCommand?: (
    lease: { leaseId: string; profile: WorkerProfile },
    command: {
      createScript: (setupEnv?: Record<string, string>) => string;
      workspaceDir: string;
      homeDir: string;
      timeoutMs: number;
      assertCurrent: () => void;
      signal?: AbortSignal;
    },
  ) => Promise<SpawnResult | undefined>;
  /**
   * Prepare without allocating, renewing, enrolling, or changing a provider resource. The
   * returned operation carries prepared facts; core records allocation intent before calling it.
   * Replay preparation cannot attest that an earlier operation allocated nothing.
   */
  prepareProvision?: (
    ...args: Parameters<WorkerProvider["provision"]>
  ) => Promise<() => Promise<WorkerLease>>;
  /** Maximum core wait for one provision attempt, including provider-owned setup and cleanup. */
  resolveProvisionTimeoutMs?: (
    profile: WorkerProfile,
    options?: { nodeBootstrapTimeoutMs?: number },
  ) => number;
  /**
   * Throws on transient/indeterminate observation failures. `unknown` means the provider no
   * longer recognizes a usable lease; core fences it and requests destroy. Only `destroyed`
   * proves teardown complete and lets core skip destroy.
   */
  inspect: (lease: {
    leaseId: string;
    profile: WorkerProfile;
    resourceReceipt?: WorkerResourceReceipt;
    retention?: WorkerRetentionPolicy;
    signal?: AbortSignal;
  }) => Promise<WorkerLeaseStatus>;
  /**
   * Converge one durably recorded operation on the exact retained resource. A lost
   * reply retains that same operation; success requires independent readback.
   * Policy and receipts are facts, not authority: recheck assertCurrent before effects.
   */
  setRetainedState?: (
    lease: Parameters<WorkerProvider["inspect"]>[0] & {
      resourceReceipt: WorkerResourceReceipt;
      retention: WorkerRetentionPolicy;
      operation: WorkerRetentionOperation;
      assertCurrent: () => void;
    },
  ) => Promise<WorkerRetentionObservation>;
  /**
   * Resolves provider-owned dynamic identities. When absent, the gateway uses its generic
   * SecretRef resolver; when present, failures are authoritative and never fall back.
   */
  resolveSshIdentity?: (request: WorkerSshIdentityRequest) => Promise<WorkerSshIdentity>;
  renew?: (leaseId: string) => Promise<void>;
  /**
   * Bounded cleanup for configured profiles, including when no leases remain. Core schedules
   * one pass at a time without blocking allocation. Check authority before external effects
   * and after awaits before persistence; settle only after all owned commands have stopped.
   */
  maintain?: (context: {
    profiles: readonly WorkerProfile[];
    signal: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<void>;
  /** Opt in to the cleanup-acceptance notification during session reclaim. */
  supportsCleanupAcceptance?: true;
  /** Idempotent; resolves only after the provider can prove teardown. */
  destroy: (lease: {
    leaseId: string;
    profile: WorkerProfile;
    resourceReceipt?: WorkerResourceReceipt;
    retention?: WorkerRetentionPolicy;
    /** Recheck current authority after waits and immediately before effects. */
    assertCurrent?: () => void;
    /** Cancel commands, await their settlement, and reject while teardown remains unconfirmed. */
    signal?: AbortSignal;
    /**
     * Optional notification that cleanup is accepted and no longer needs the session.
     * The host may reclaim the session, but retains this operation until its promise settles.
     * Call only after durable provider acceptance (or a claimed, provider-owned capture).
     * Fulfillment must still prove physical teardown; rejection remains retryable.
     * Providers without this capability ignore the callback and keep blocking reclaim.
     */
    onCleanupAccepted?: () => void;
  }) => Promise<void>;
  /** Maximum core wait for teardown, including provider-owned checkpointing and cleanup. */
  resolveDestroyTimeoutMs?: (profile: WorkerProfile) => number;
};

export type SpeechProviderPlugin = {
  id: SpeechProviderId;
  label: string;
  aliases?: string[];
  autoSelectOrder?: number;
  /** Default provider operation timeout in milliseconds when caller/config omit timeoutMs. */
  defaultTimeoutMs?: number;
  defaultModel?: string;
  models?: readonly string[];
  voices?: readonly string[];
  resolveConfig?: (ctx: SpeechProviderResolveConfigContext) => SpeechProviderConfig;
  parseDirectiveToken?: (ctx: SpeechDirectiveTokenParseContext) => SpeechDirectiveTokenParseResult;
  resolveTalkConfig?: (ctx: SpeechProviderResolveTalkConfigContext) => SpeechProviderConfig;
  resolveTalkOverrides?: (
    ctx: SpeechProviderResolveTalkOverridesContext,
  ) => SpeechProviderConfig | undefined;
  prepareSynthesis?: (
    ctx: SpeechProviderPrepareSynthesisContext,
  ) =>
    | SpeechProviderPreparedSynthesis
    | undefined
    | Promise<SpeechProviderPreparedSynthesis | undefined>;
  /** @deprecated Use isConfiguredAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  isConfigured: (ctx: SpeechProviderConfiguredContext) => boolean;
  isConfiguredAsync?: (ctx: SpeechProviderConfiguredContext) => Promise<boolean>;
  synthesize: (req: SpeechSynthesisRequest) => Promise<SpeechSynthesisResult>;
  streamSynthesize?: (req: SpeechSynthesisStreamRequest) => Promise<SpeechSynthesisStreamResult>;
  synthesizeTelephony?: (
    req: SpeechTelephonySynthesisRequest,
  ) => Promise<SpeechTelephonySynthesisResult>;
  listVoices?: (req: SpeechListVoicesRequest) => Promise<SpeechVoiceOption[]>;
};

export type RealtimeTranscriptionProviderPlugin = {
  id: RealtimeTranscriptionProviderId;
  label: string;
  aliases?: string[];
  defaultModel?: string;
  models?: readonly string[];
  autoSelectOrder?: number;
  resolveConfig?: (
    ctx: RealtimeTranscriptionProviderResolveConfigContext,
  ) => RealtimeTranscriptionProviderConfig;
  /** @deprecated Use isConfiguredAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  isConfigured: (ctx: RealtimeTranscriptionProviderConfiguredContext) => boolean;
  isConfiguredAsync?: (ctx: RealtimeTranscriptionProviderConfiguredContext) => Promise<boolean>;
  createSession: (req: RealtimeTranscriptionSessionCreateRequest) => RealtimeTranscriptionSession;
};

export type TranscriptSourceProvider = TranscriptsSourceProviderCapability;

export type RealtimeVoiceProviderPlugin = {
  id: RealtimeVoiceProviderId;
  label: string;
  aliases?: string[];
  defaultModel?: string;
  models?: readonly string[];
  /** Known speaker voices for pickers; providers still accept free-form values. */
  voices?: readonly string[];
  autoSelectOrder?: number;
  capabilities?: RealtimeVoiceProviderCapabilities;
  /** @deprecated Use resolveConfigAsync when config resolution needs credentials. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  resolveConfig?: (ctx: RealtimeVoiceProviderResolveConfigContext) => RealtimeVoiceProviderConfig;
  resolveConfigAsync?: (
    ctx: RealtimeVoiceProviderResolveConfigContext,
  ) => Promise<RealtimeVoiceProviderConfig>;
  /** @deprecated Use isConfiguredAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  isConfigured: (ctx: RealtimeVoiceProviderConfiguredContext) => boolean;
  isConfiguredAsync?: (ctx: RealtimeVoiceProviderConfiguredContext) => Promise<boolean>;
  createBridge: (req: RealtimeVoiceBridgeCreateRequest) => RealtimeVoiceBridge;
  createBrowserSession?: (
    req: RealtimeVoiceBrowserSessionCreateRequest,
  ) => Promise<RealtimeVoiceBrowserSession>;
};

export type MediaUnderstandingProviderPlugin = MediaUnderstandingProvider;
export type ImageGenerationProviderPlugin = ImageGenerationProvider;
export type VideoGenerationProviderPlugin = VideoGenerationProvider;
export type MusicGenerationProviderPlugin = MusicGenerationProvider;
