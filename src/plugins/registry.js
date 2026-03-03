import path from "node:path";
import { registerInternalHook } from "../hooks/internal-hooks.js";
import { resolveUserPath } from "../utils.js";
import { registerPluginCommand } from "./commands.js";
import { normalizePluginHttpPath } from "./http-path.js";
export function createEmptyPluginRegistry() {
    return {
        plugins: [],
        tools: [],
        hooks: [],
        typedHooks: [],
        channels: [],
        providers: [],
        gatewayHandlers: {},
        httpRoutes: [],
        cliRegistrars: [],
        services: [],
        commands: [],
        diagnostics: [],
    };
}
export function createPluginRegistry(registryParams) {
    const registry = createEmptyPluginRegistry();
    const coreGatewayMethods = new Set(Object.keys(registryParams.coreGatewayHandlers ?? {}));
    const pushDiagnostic = (diag) => {
        registry.diagnostics.push(diag);
    };
    const registerTool = (record, tool, opts) => {
        const names = opts?.names ?? (opts?.name ? [opts.name] : []);
        const optional = opts?.optional === true;
        const factory = typeof tool === "function" ? tool : (_ctx) => tool;
        if (typeof tool !== "function") {
            names.push(tool.name);
        }
        const normalized = names.map((name) => name.trim()).filter(Boolean);
        if (normalized.length > 0) {
            record.toolNames.push(...normalized);
        }
        registry.tools.push({
            pluginId: record.id,
            factory,
            names: normalized,
            optional,
            source: record.source,
        });
    };
    const registerHook = (record, events, handler, opts, config) => {
        const eventList = Array.isArray(events) ? events : [events];
        const normalizedEvents = eventList.map((event) => event.trim()).filter(Boolean);
        const entry = opts?.entry ?? null;
        const name = entry?.hook.name ?? opts?.name?.trim();
        if (!name) {
            pushDiagnostic({
                level: "warn",
                pluginId: record.id,
                source: record.source,
                message: "hook registration missing name",
            });
            return;
        }
        const description = entry?.hook.description ?? opts?.description ?? "";
        const hookEntry = entry
            ? {
                ...entry,
                hook: {
                    ...entry.hook,
                    name,
                    description,
                    source: "openclaw-plugin",
                    pluginId: record.id,
                },
                metadata: {
                    ...entry.metadata,
                    events: normalizedEvents,
                },
            }
            : {
                hook: {
                    name,
                    description,
                    source: "openclaw-plugin",
                    pluginId: record.id,
                    filePath: record.source,
                    baseDir: path.dirname(record.source),
                    handlerPath: record.source,
                },
                frontmatter: {},
                metadata: { events: normalizedEvents },
                invocation: { enabled: true },
            };
        record.hookNames.push(name);
        registry.hooks.push({
            pluginId: record.id,
            entry: hookEntry,
            events: normalizedEvents,
            source: record.source,
        });
        const hookSystemEnabled = config?.hooks?.internal?.enabled === true;
        if (!hookSystemEnabled || opts?.register === false) {
            return;
        }
        for (const event of normalizedEvents) {
            registerInternalHook(event, handler);
        }
    };
    const registerGatewayMethod = (record, method, handler) => {
        const trimmed = method.trim();
        if (!trimmed) {
            return;
        }
        if (coreGatewayMethods.has(trimmed) || registry.gatewayHandlers[trimmed]) {
            pushDiagnostic({
                level: "error",
                pluginId: record.id,
                source: record.source,
                message: `gateway method already registered: ${trimmed}`,
            });
            return;
        }
        registry.gatewayHandlers[trimmed] = handler;
        record.gatewayMethods.push(trimmed);
    };
    const describeHttpRouteOwner = (entry) => {
        const plugin = entry.pluginId?.trim() || "unknown-plugin";
        const source = entry.source?.trim() || "unknown-source";
        return `${plugin} (${source})`;
    };
    const registerHttpRoute = (record, params) => {
        const normalizedPath = normalizePluginHttpPath(params.path);
        if (!normalizedPath) {
            pushDiagnostic({
                level: "warn",
                pluginId: record.id,
                source: record.source,
                message: "http route registration missing path",
            });
            return;
        }
        if (params.auth !== "gateway" && params.auth !== "plugin") {
            pushDiagnostic({
                level: "error",
                pluginId: record.id,
                source: record.source,
                message: `http route registration missing or invalid auth: ${normalizedPath}`,
            });
            return;
        }
        const match = params.match ?? "exact";
        const existingIndex = registry.httpRoutes.findIndex((entry) => entry.path === normalizedPath && entry.match === match);
        if (existingIndex >= 0) {
            const existing = registry.httpRoutes[existingIndex];
            if (!existing) {
                return;
            }
            if (!params.replaceExisting) {
                pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `http route already registered: ${normalizedPath} (${match}) by ${describeHttpRouteOwner(existing)}`,
                });
                return;
            }
            if (existing.pluginId && existing.pluginId !== record.id) {
                pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `http route replacement rejected: ${normalizedPath} (${match}) owned by ${describeHttpRouteOwner(existing)}`,
                });
                return;
            }
            registry.httpRoutes[existingIndex] = {
                pluginId: record.id,
                path: normalizedPath,
                handler: params.handler,
                auth: params.auth,
                match,
                source: record.source,
            };
            return;
        }
        record.httpRoutes += 1;
        registry.httpRoutes.push({
            pluginId: record.id,
            path: normalizedPath,
            handler: params.handler,
            auth: params.auth,
            match,
            source: record.source,
        });
    };
    const registerChannel = (record, registration) => {
        const normalized = typeof registration.plugin === "object"
            ? registration
            : { plugin: registration };
        const plugin = normalized.plugin;
        const id = typeof plugin?.id === "string" ? plugin.id.trim() : String(plugin?.id ?? "").trim();
        if (!id) {
            pushDiagnostic({
                level: "error",
                pluginId: record.id,
                source: record.source,
                message: "channel registration missing id",
            });
            return;
        }
        record.channelIds.push(id);
        registry.channels.push({
            pluginId: record.id,
            plugin,
            dock: normalized.dock,
            source: record.source,
        });
    };
    const registerProvider = (record, provider) => {
        const id = typeof provider?.id === "string" ? provider.id.trim() : "";
        if (!id) {
            pushDiagnostic({
                level: "error",
                pluginId: record.id,
                source: record.source,
                message: "provider registration missing id",
            });
            return;
        }
        const existing = registry.providers.find((entry) => entry.provider.id === id);
        if (existing) {
            pushDiagnostic({
                level: "error",
                pluginId: record.id,
                source: record.source,
                message: `provider already registered: ${id} (${existing.pluginId})`,
            });
            return;
        }
        record.providerIds.push(id);
        registry.providers.push({
            pluginId: record.id,
            provider,
            source: record.source,
        });
    };
    const registerCli = (record, registrar, opts) => {
        const commands = (opts?.commands ?? []).map((cmd) => cmd.trim()).filter(Boolean);
        record.cliCommands.push(...commands);
        registry.cliRegistrars.push({
            pluginId: record.id,
            register: registrar,
            commands,
            source: record.source,
        });
    };
    const registerService = (record, service) => {
        const id = service.id.trim();
        if (!id) {
            return;
        }
        record.services.push(id);
        registry.services.push({
            pluginId: record.id,
            service,
            source: record.source,
        });
    };
    const registerCommand = (record, command) => {
        const name = command.name.trim();
        if (!name) {
            pushDiagnostic({
                level: "error",
                pluginId: record.id,
                source: record.source,
                message: "command registration missing name",
            });
            return;
        }
        // Register with the plugin command system (validates name and checks for duplicates)
        const result = registerPluginCommand(record.id, command);
        if (!result.ok) {
            pushDiagnostic({
                level: "error",
                pluginId: record.id,
                source: record.source,
                message: `command registration failed: ${result.error}`,
            });
            return;
        }
        record.commands.push(name);
        registry.commands.push({
            pluginId: record.id,
            command,
            source: record.source,
        });
    };
    const registerTypedHook = (record, hookName, handler, opts) => {
        record.hookCount += 1;
        registry.typedHooks.push({
            pluginId: record.id,
            hookName,
            handler,
            priority: opts?.priority,
            source: record.source,
        });
    };
    const normalizeLogger = (logger) => ({
        info: logger.info,
        warn: logger.warn,
        error: logger.error,
        debug: logger.debug,
    });
    const createApi = (record, params) => {
        return {
            id: record.id,
            name: record.name,
            version: record.version,
            description: record.description,
            source: record.source,
            config: params.config,
            pluginConfig: params.pluginConfig,
            runtime: registryParams.runtime,
            logger: normalizeLogger(registryParams.logger),
            registerTool: (tool, opts) => registerTool(record, tool, opts),
            registerHook: (events, handler, opts) => registerHook(record, events, handler, opts, params.config),
            registerHttpRoute: (params) => registerHttpRoute(record, params),
            registerChannel: (registration) => registerChannel(record, registration),
            registerProvider: (provider) => registerProvider(record, provider),
            registerGatewayMethod: (method, handler) => registerGatewayMethod(record, method, handler),
            registerCli: (registrar, opts) => registerCli(record, registrar, opts),
            registerService: (service) => registerService(record, service),
            registerCommand: (command) => registerCommand(record, command),
            resolvePath: (input) => resolveUserPath(input),
            on: (hookName, handler, opts) => registerTypedHook(record, hookName, handler, opts),
        };
    };
    return {
        registry,
        createApi,
        pushDiagnostic,
        registerTool,
        registerChannel,
        registerProvider,
        registerGatewayMethod,
        registerCli,
        registerService,
        registerCommand,
        registerHook,
        registerTypedHook,
    };
}
