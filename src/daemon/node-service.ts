import {
  NODE_SERVICE_KIND,
  resolveGatewayProfileSuffix,
  resolveNodeServiceIdentityEnvironment,
} from "./constants.js";
import type { GatewayService, GatewayServiceInstallArgs } from "./service.js";
import { resolveGatewayService } from "./service.js";

function withNodeServiceEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  // Node services reuse gateway platform installers; env overrides select the
  // node-specific labels, logs, task script, and service marker.
  return {
    ...env,
    ...resolveNodeServiceIdentityEnvironment(env),
  };
}

function withNodeInstallEnv(args: GatewayServiceInstallArgs): GatewayServiceInstallArgs {
  const identity = resolveNodeServiceIdentityEnvironment(args.env);
  return {
    ...args,
    env: { ...args.env, ...identity },
    environment: { ...args.environment, ...identity },
  };
}

export function resolveNodeService(): GatewayService {
  const base = resolveGatewayService("node");
  const { hasInstalledDefinition, isAbsent, readDefinitionMutationCapability } = base;
  const owned = <
    T extends { env: Record<string, string | undefined>; beforeMutation?: () => Promise<void> },
  >(
    args: T,
  ) => ({
    ...args,
    beforeMutation: async () => {
      await args.beforeMutation?.();
      const command = await base.readCommand(args.env);
      const kind = command?.environment?.OPENCLAW_SERVICE_KIND?.trim();
      // A profile's node name can also name another profile's legacy Gateway.
      // Keep unmarked default nodes manageable; named nodes always carry a kind.
      if (
        command &&
        kind !== NODE_SERVICE_KIND &&
        (kind || resolveGatewayProfileSuffix(args.env.OPENCLAW_PROFILE))
      ) {
        throw new Error(
          `${command.sourcePath ?? "The selected service"} is not an OpenClaw node service. Node commands left it unchanged; move the conflicting service before managing this node.`,
        );
      }
    },
  });
  return {
    ...base,
    stage: (args) => base.stage(owned(withNodeInstallEnv(args))),
    install: (args) => base.install(owned(withNodeInstallEnv(args))),
    uninstall: (args) => base.uninstall(owned({ ...args, env: withNodeServiceEnv(args.env) })),
    start: (args) => base.start(owned({ ...args, env: withNodeServiceEnv(args.env ?? {}) })),
    stop: (args) => base.stop(owned({ ...args, env: withNodeServiceEnv(args.env ?? {}) })),
    restart: (args) => base.restart(owned({ ...args, env: withNodeServiceEnv(args.env ?? {}) })),
    isLoaded: (args) => {
      // Preserve the status read deadline so node probes fail soft under a
      // wedged service manager instead of hanging the whole status command.
      return base.isLoaded({ env: withNodeServiceEnv(args.env ?? {}), timeoutMs: args.timeoutMs });
    },
    hasInstalledDefinition: hasInstalledDefinition
      ? (args) => hasInstalledDefinition({ ...args, env: withNodeServiceEnv(args.env ?? {}) })
      : undefined,
    isAbsent: isAbsent
      ? (args) => isAbsent({ ...args, env: withNodeServiceEnv(args.env ?? {}) })
      : undefined,
    readDefinitionMutationCapability: readDefinitionMutationCapability
      ? (args) =>
          readDefinitionMutationCapability({
            ...args,
            env: withNodeServiceEnv(args.env ?? {}),
            environment: args.environment ? withNodeServiceEnv(args.environment) : undefined,
          })
      : undefined,
    readCommand: (env, opts) => base.readCommand(withNodeServiceEnv(env), opts),
    readRuntime: (env, opts) => base.readRuntime(withNodeServiceEnv(env), opts),
  };
}
