// OpenClaw operation contracts shared by parsing and execution.
import type { ConfigSetOptions } from "../cli/config-set-input.js";
import type { DoctorOptions } from "../commands/doctor.types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TuiResult } from "../tui/tui-types.js";
import type { SystemAgentOverview } from "./overview.js";

type SystemAgentOverviewLoader = () => Promise<SystemAgentOverview>;
type SystemAgentOverviewFormatter = (overview: SystemAgentOverview) => string;

export type SystemAgentOperation =
  | { kind: "none"; message: string }
  | { kind: "overview" }
  | { kind: "doctor" }
  | { kind: "doctor-fix" }
  | { kind: "status" }
  | { kind: "health" }
  | { kind: "config-validate" }
  | { kind: "config-get"; path: string }
  | { kind: "config-schema"; path?: string }
  | { kind: "config-set"; path: string; value: string }
  | {
      kind: "config-set-ref";
      path: string;
      source: "env" | "file" | "exec";
      id: string;
      provider?: string;
    }
  | { kind: "setup"; workspace?: string; model?: string }
  | { kind: "model-setup"; workspace?: string }
  | { kind: "channel-list" }
  | { kind: "channel-info"; channel: string }
  | { kind: "channel-setup"; channel: string }
  | {
      kind: "open-setup";
      target: "guided" | "classic" | "channels";
      channel?: string;
    }
  | { kind: "gateway-status" }
  | { kind: "gateway-start" }
  | { kind: "gateway-stop" }
  | { kind: "gateway-restart" }
  | { kind: "agents" }
  | { kind: "models" }
  | { kind: "plugin-list" }
  | { kind: "plugin-search"; query: string }
  | { kind: "plugin-install"; spec: string }
  | { kind: "plugin-uninstall"; pluginId: string }
  | { kind: "audit" }
  | { kind: "create-agent"; agentId: string; workspace?: string; model?: string }
  | { kind: "open-tui"; agentId?: string; workspace?: string }
  | { kind: "set-default-model"; model: string };

/** Result returned by the operation executor. */
export type SystemAgentOperationResult = {
  applied: boolean;
  exitsInteractive?: boolean;
  message?: string;
  nextInput?: string;
  /** Agent TUI exited via /openclaw: re-enter the shell even without a request. */
  returnToShell?: boolean;
  followUp?: Extract<SystemAgentOperation, { kind: "model-setup" }>;
};

/** Injectable command dependencies used by tests and alternate runners. */
export type SystemAgentCommandDeps = {
  readConfigFileSnapshot?: typeof import("../config/config.js").readConfigFileSnapshot;
  ensureAuthProfileStore?: typeof import("../agents/auth-profiles/store.js").ensureAuthProfileStore;
  resolveCliAuthBindingFingerprint?: typeof import("../agents/cli-auth-epoch.js").resolveCliAuthBindingFingerprint;
  resolveApiKeyForProvider?: typeof import("../agents/model-auth.js").resolveApiKeyForProvider;
  formatOverview?: SystemAgentOverviewFormatter;
  loadOverview?: SystemAgentOverviewLoader;
  runAgentsAdd?: (
    opts: {
      name?: string;
      workspace?: string;
      model?: string;
      nonInteractive?: boolean;
      json?: boolean;
    },
    runtime: RuntimeEnv,
    params?: { hasFlags?: boolean },
  ) => Promise<void>;
  runConfigSet?: (opts: {
    path?: string;
    value?: string;
    cliOptions: ConfigSetOptions;
  }) => Promise<void>;
  runDoctor?: (runtime: RuntimeEnv, options: DoctorOptions) => Promise<void>;
  runGatewayRestart?: () => Promise<void | boolean>;
  runGatewayStart?: () => Promise<void>;
  runGatewayStop?: () => Promise<void>;
  runPluginInstall?: (spec: string, runtime: RuntimeEnv) => Promise<void>;
  runPluginUninstall?: (pluginId: string, runtime: RuntimeEnv) => Promise<void>;
  runPluginsList?: (runtime: RuntimeEnv) => Promise<void>;
  runPluginsSearch?: (query: string, runtime: RuntimeEnv) => Promise<void>;
  runTui?: (opts: {
    local: boolean;
    session?: string;
    deliver?: boolean;
    historyLimit?: number;
  }) => Promise<TuiResult | void>;
  /** Where setup side effects run; the gateway surface never manages its own daemon. */
  setupSurface?: "cli" | "gateway";
  applySetup?: typeof import("./setup-apply.js").applySystemAgentSetup;
  verifyInferenceConfig?: typeof import("./setup-inference.js").verifySetupInferenceConfig;
  listChannelSetupPlugins?: typeof import("../channels/plugins/setup-registry.js").listChannelSetupPlugins;
  resolveChannelSetupEntries?: typeof import("../commands/channel-setup/discovery.js").resolveChannelSetupEntries;
  isChannelConfigured?: typeof import("../config/channel-configured-shared.js").isStaticallyChannelConfigured;
};

export type ExecuteOptions = {
  approved?: boolean;
  deps?: SystemAgentCommandDeps;
  auditDetails?: Record<string, unknown>;
  /**
   * Authority check used by the guarded commit seam for host-approved writes.
   * A multi-step operation may invoke it more than once; every invocation is
   * immediately followed by the persistent effect it authorizes.
   */
  beforePersistentApply?: () => Promise<void>;
};
