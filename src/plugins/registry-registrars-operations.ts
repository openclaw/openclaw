import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  normalizeStringEntries,
  normalizeUniqueStringEntries,
} from "@openclaw/normalization-core/string-normalization";
import { normalizePluginCliRegistrationMetadata } from "../cli/program/command-descriptor-utils.js";
import {
  NODE_EXEC_APPROVALS_COMMANDS,
  isPrivateNodeInvokeCommand,
  NODE_SYSTEM_NOTIFY_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
  NODE_WORKER_PRIVATE_COMMANDS,
} from "../infra/node-commands.js";
import {
  isReservedCommandName,
  registerPluginCommandInRegistry,
  snapshotPluginCommandRuntimeCapabilities,
} from "./command-registration.js";
import { bindPluginGatewayAccessPolicy } from "./gateway-access-policy-registration.js";
import type { PluginGatewayAccessPolicy } from "./gateway-access-policy.types.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { WidgetPresenter } from "./plugin-registration.types.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import type {
  OpenClawGatewayDiscoveryService,
  OpenClawPluginCliRegistrationOptions,
  OpenClawPluginCliRegistrar,
  OpenClawPluginCommandDefinition,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginReloadRegistration,
  OpenClawPluginSecurityAuditCollector,
  OpenClawPluginService,
  OpenClawPluginServiceV2,
} from "./types.js";

function isOfficialCodexPluginRecord(
  record: Pick<PluginRecord, "id" | "origin" | "packageName" | "rootDir" | "source">,
) {
  if (record.id !== "codex" || record.origin !== "global") {
    return false;
  }
  if (record.packageName === "@openclaw/codex") {
    return true;
  }
  const sourcePath = path
    .normalize(record.rootDir ?? record.source)
    .split(path.sep)
    .join("/");
  return sourcePath.includes("/node_modules/@openclaw/codex");
}

export function canClaimReservedCommandOwnership(
  record: Pick<PluginRecord, "id" | "origin" | "packageName" | "rootDir" | "source">,
) {
  return record.origin === "bundled" || isOfficialCodexPluginRecord(record);
}

export function createOperationRegistrars(state: PluginRegistryState) {
  const {
    registry,
    createRegistration,
    createIdentityRegistration,
    reportRegistrationError,
    reportRegistrationWarning,
  } = state;

  const registerWidgetPresenter = (record: PluginRecord, presenter: WidgetPresenter) => {
    const description = normalizeOptionalString(presenter.description);
    const currentCapabilities =
      presenter.target === "current_channel" ? presenter.capabilities : undefined;
    const currentChannelValid =
      presenter.target === "current_channel" &&
      typeof presenter.match === "function" &&
      currentCapabilities !== undefined &&
      Array.isArray(currentCapabilities.sourceKinds) &&
      currentCapabilities.sourceKinds.length > 0 &&
      currentCapabilities.sourceKinds.every(
        (kind) => typeof kind === "string" && kind.trim().length > 0,
      ) &&
      (currentCapabilities.maxSourceBytes === undefined ||
        (Number.isInteger(currentCapabilities.maxSourceBytes) &&
          currentCapabilities.maxSourceBytes > 0));
    if (
      (presenter.target !== "node_panel" && !currentChannelValid) ||
      !description ||
      description.length > 160 ||
      typeof presenter.availability !== "function" ||
      typeof presenter.present !== "function"
    ) {
      reportRegistrationError(record, "invalid widget presenter registration");
      return;
    }
    const existing =
      presenter.target === "current_channel"
        ? undefined
        : registry.widgetPresenters.find(
            (registration) => registration.presenter.target === presenter.target,
          );
    if (existing) {
      reportRegistrationError(
        record,
        `widget presenter already registered for ${presenter.target} (${existing.pluginId})`,
      );
      return;
    }
    registry.widgetPresenters.push(
      createRegistration(record, {
        presenter: { ...presenter, description },
      }),
    );
  };

  const registerCli = (
    record: PluginRecord,
    registrar: OpenClawPluginCliRegistrar,
    opts?: OpenClawPluginCliRegistrationOptions,
  ) => {
    const metadata = normalizePluginCliRegistrationMetadata(opts, (message) =>
      reportRegistrationError(record, message),
    );
    if (!metadata) {
      return;
    }
    const { parentPath: normalizedParentPath, commands, descriptors } = metadata;
    const serializeCommandPath = (command: string) => [...normalizedParentPath, command].join(" ");
    const commandPaths = commands.map(serializeCommandPath);
    const commandPathSet = new Set(commandPaths);
    const existing = registry.cliRegistrars.find((entry) =>
      entry.commands
        .map((command) => [...entry.parentPath, command].join(" "))
        .some((commandPath) => commandPathSet.has(commandPath)),
    );
    if (existing) {
      const existingCommandPaths = new Set(
        existing.commands.map((command) => [...existing.parentPath, command].join(" ")),
      );
      const overlap = commandPaths.find((commandPath) => existingCommandPaths.has(commandPath));
      reportRegistrationError(
        record,
        `cli command already registered: ${overlap ?? commands[0]} (${existing.pluginId})`,
      );
      return;
    }
    record.cliCommands.push(...commandPaths);
    registry.cliRegistrars.push(
      createRegistration(record, {
        register: registrar,
        parentPath: normalizedParentPath,
        commands,
        descriptors,
      }),
    );
  };

  const registerReload = (record: PluginRecord, registration: OpenClawPluginReloadRegistration) => {
    const normalized: OpenClawPluginReloadRegistration = {
      restartPrefixes: normalizeStringEntries(registration.restartPrefixes),
      hotPrefixes: normalizeStringEntries(registration.hotPrefixes),
      noopPrefixes: normalizeStringEntries(registration.noopPrefixes),
    };
    if (
      (normalized.restartPrefixes?.length ?? 0) === 0 &&
      (normalized.hotPrefixes?.length ?? 0) === 0 &&
      (normalized.noopPrefixes?.length ?? 0) === 0
    ) {
      reportRegistrationWarning(record, "reload registration missing prefixes");
      return;
    }
    registry.reloads.push(
      createRegistration(record, {
        registration: normalized,
      }),
    );
  };

  const reservedNodeHostCommands = new Set<string>([
    ...NODE_SYSTEM_RUN_COMMANDS,
    ...NODE_EXEC_APPROVALS_COMMANDS,
    NODE_SYSTEM_NOTIFY_COMMAND,
    ...NODE_WORKER_PRIVATE_COMMANDS,
  ]);

  const registerNodeHostCommand = (
    record: PluginRecord,
    nodeCommand: OpenClawPluginNodeHostCommand,
  ) => {
    const command = nodeCommand.command.trim();
    if (!command) {
      reportRegistrationError(record, "node host command registration missing command");
      return;
    }
    // Native nodes already own system.notify. A bundled node-host plugin may
    // supply it on platforms without a native app, while external plugins stay blocked.
    const bundledSystemNotify =
      record.origin === "bundled" && command === NODE_SYSTEM_NOTIFY_COMMAND;
    if (reservedNodeHostCommands.has(command) && !bundledSystemNotify) {
      reportRegistrationError(record, `node host command reserved by core: ${command}`);
      return;
    }
    const existing = registry.nodeHostCommands.find((entry) => entry.command.command === command);
    if (existing) {
      reportRegistrationError(
        record,
        `node host command already registered: ${command} (${existing.pluginId})`,
      );
      return;
    }
    const normalizedCommand = {
      ...nodeCommand,
      command,
      cap: normalizeOptionalString(nodeCommand.cap),
    };
    registry.nodeHostCommands.push(
      createRegistration(record, {
        command: record.nativeSessionCatalog?.nodeCommands?.includes(command)
          ? (state.getNativeCatalogGate(record)?.node(normalizedCommand) ?? normalizedCommand)
          : normalizedCommand,
      }),
    );
  };

  const registerNodeInvokePolicy = (
    record: PluginRecord,
    policy: OpenClawPluginNodeInvokePolicy,
    pluginConfig?: Record<string, unknown>,
  ) => {
    const commands = normalizeUniqueStringEntries(
      Array.isArray(policy.commands) ? policy.commands : [],
    );
    if (commands.length === 0) {
      reportRegistrationError(record, "node invoke policy registration missing commands");
      return;
    }
    const reservedCommand = commands.find(isPrivateNodeInvokeCommand);
    if (reservedCommand) {
      reportRegistrationError(
        record,
        `node invoke policy command reserved by core: ${reservedCommand}`,
      );
      return;
    }
    if (typeof policy.handle !== "function") {
      reportRegistrationError(
        record,
        `node invoke policy registration missing handler: ${commands.join(", ")}`,
      );
      return;
    }
    for (const command of commands) {
      const existing = registry.nodeInvokePolicies.find((entry) =>
        entry.policy.commands.includes(command),
      );
      if (existing) {
        reportRegistrationError(
          record,
          `node invoke policy already registered for ${command} (${existing.pluginId})`,
        );
        return;
      }
    }
    registry.nodeInvokePolicies.push(
      createRegistration(record, {
        policy: { ...policy, commands },
        pluginConfig,
      }),
    );
  };

  const registerSecurityAuditCollector = (
    record: PluginRecord,
    collector: OpenClawPluginSecurityAuditCollector,
  ) => {
    registry.securityAuditCollectors.push(
      createRegistration(record, {
        collector,
      }),
    );
  };

  const registerGatewayAccessPolicy = (record: PluginRecord, policy: PluginGatewayAccessPolicy) => {
    if (typeof policy.authorize !== "function") {
      reportRegistrationError(record, "Gateway access policy requires an authorize handler");
      return;
    }
    registry.gatewayAccessPolicies.push(
      createIdentityRegistration(record, {
        policy: bindPluginGatewayAccessPolicy(policy, getPluginInstance(record)),
      }),
    );
  };

  const registerRepositoryIntegration = (
    record: PluginRecord,
    integration: import("./repository-integration.types.js").RepositoryIntegration,
  ) => {
    if (
      integration.version !== 1 ||
      typeof integration.withIdentity !== "function" ||
      typeof integration.resolveConnectionIdentity !== "function" ||
      !["image", "repository"].includes(integration.preparedCapacity) ||
      registry.repositoryIntegrations.some((entry) => entry.pluginId === record.id)
    ) {
      reportRegistrationError(record, "Invalid or duplicate repository integration");
      return;
    }
    const instance = getPluginInstance(record);
    if (!instance) {
      reportRegistrationError(record, "Repository integration requires a live plugin instance");
      return;
    }
    const bound = instance.wrap(integration);
    const scoped: import("./repository-integration.types.js").RepositoryIntegration = {
      version: 1,
      preparedCapacity: bound.preparedCapacity,
      resolveConnectionIdentity: bound.resolveConnectionIdentity,
      // Callback arguments are plugin values too; bind their retained callables
      // before the native credential owner can keep them past this invocation.
      withIdentity: (context, run) =>
        bound.withIdentity(context, (scope) => run(instance.wrap(scope))),
    };
    registry.repositoryIntegrations.push(
      createIdentityRegistration(record, {
        assertCurrent: () => {
          if (!instance.acceptingCalls || instance.disposing) {
            throw new PluginInstanceUnavailableError(record.id);
          }
          instance.lifecycle.signal.throwIfAborted();
        },
        integration: scoped,
      }),
    );
  };

  const resolveServiceRegistrationId = (
    record: PluginRecord,
    service: { id: string },
    kind: "service" | "gateway discovery service",
  ) => {
    try {
      const id = service.id.trim();
      const registrations =
        kind === "service" ? registry.services : registry.gatewayDiscoveryServices;
      const existing = id ? registrations.find((entry) => entry.id === id) : undefined;
      if (id && !existing) {
        return id;
      }
      // Snapshot and activating loads can both register the same owner; keep the first.
      if (existing?.pluginId !== record.id) {
        reportRegistrationError(
          record,
          existing
            ? `${kind} already registered: ${id} (${existing.pluginId})`
            : `${kind} registration missing id`,
        );
      }
    } catch {
      // Plugin accessors can throw sensitive values; report only the boundary failure.
      reportRegistrationError(record, `${kind} registration id cannot be normalized`);
    }
    return undefined;
  };

  const registerService = (
    record: PluginRecord,
    service: OpenClawPluginService | OpenClawPluginServiceV2,
  ) => {
    const id = resolveServiceRegistrationId(record, service, "service");
    if (!id) {
      return;
    }
    record.services.push(id);
    registry.services.push({
      id,
      pluginId: record.id,
      pluginName: record.name,
      service,
      source: record.source,
      origin: record.origin,
      trustedOfficialInstall: record.trustedOfficialInstall,
      rootDir: record.rootDir,
    });
  };

  const registerGatewayDiscoveryService = (
    record: PluginRecord,
    service: OpenClawGatewayDiscoveryService,
  ) => {
    const id = resolveServiceRegistrationId(record, service, "gateway discovery service");
    if (!id) {
      return;
    }
    record.gatewayDiscoveryServiceIds.push(id);
    registry.gatewayDiscoveryServices.push({
      ...createRegistration(record, { id, service }),
      // The advertiser can be native data; its registration still owns execution and cleanup.
      instance: getPluginInstance(record),
    });
  };

  const registerCommand = (
    record: PluginRecord,
    callerCommand: OpenClawPluginCommandDefinition,
  ) => {
    const command = snapshotPluginCommandRuntimeCapabilities(callerCommand);
    const name = command.name.trim();
    if (!name) {
      reportRegistrationError(record, "command registration missing name");
      return;
    }
    const allowReservedCommandNames = command.ownership === "reserved";
    if (allowReservedCommandNames && !canClaimReservedCommandOwnership(record)) {
      reportRegistrationError(
        record,
        `only bundled plugins can claim reserved command ownership: ${name}`,
      );
      return;
    }
    if (allowReservedCommandNames && !isReservedCommandName(name)) {
      reportRegistrationError(
        record,
        `reserved command ownership requires a reserved command name: ${name}`,
      );
      return;
    }
    if (allowReservedCommandNames && record.id !== normalizeLowercaseStringOrEmpty(name)) {
      reportRegistrationError(
        record,
        `command registration failed: Reserved command ownership requires plugin id "${record.id}" to match reserved command name "${normalizeLowercaseStringOrEmpty(name)}"`,
      );
      return;
    }
    const { ownership: _ownership, ...commandForRegistration } = command;
    void _ownership;
    if (
      command.runtimeCapabilities?.includes("scheduledTurns") &&
      !record.contracts?.sessionScheduledTurns?.includes("requester-command")
    ) {
      reportRegistrationError(
        record,
        'scheduled command turns require contracts.sessionScheduledTurns: ["requester-command"]',
      );
      return;
    }
    const result = registerPluginCommandInRegistry(
      registry,
      record.id,
      allowReservedCommandNames ? commandForRegistration : command,
      {
        pluginName: record.name,
        pluginRoot: record.rootDir,
        allowReservedCommandNames,
        allowOwnerStatusExposure: canClaimReservedCommandOwnership(record),
      },
      record.contracts?.commandRuntimeCapabilities,
    );
    if (!result.ok) {
      reportRegistrationError(record, `command registration failed: ${result.error}`);
      return;
    }
    const registered = registry.commands.at(-1);
    if (registered?.pluginId === record.id) {
      registered.source = record.source;
      if (allowReservedCommandNames) {
        registered.command.ownership = "reserved";
      }
    }
    record.commands.push(name);
  };

  return {
    registerWidgetPresenter,
    registerCli,
    registerReload,
    registerNodeHostCommand,
    registerNodeInvokePolicy,
    registerGatewayAccessPolicy,
    registerRepositoryIntegration,
    registerSecurityAuditCollector,
    registerService,
    registerGatewayDiscoveryService,
    registerCommand,
  };
}
