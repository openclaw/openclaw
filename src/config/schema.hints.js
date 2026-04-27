import { z } from "zod";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isSensitiveUrlConfigPath, SENSITIVE_URL_HINT_TAG, } from "../shared/net/redact-sensitive-url.js";
import { FIELD_HELP } from "./schema.help.js";
import { FIELD_LABELS } from "./schema.labels.js";
import { applyDerivedTags } from "./schema.tags.js";
import { isSensitiveConfigPath } from "./sensitive-paths.js";
import { sensitive } from "./zod-schema.sensitive.js";
let log = null;
function getLog() {
    if (!log) {
        log = createSubsystemLogger("config/schema");
    }
    return log;
}
const GROUP_LABELS = {
    wizard: "Wizard",
    update: "Update",
    cli: "CLI",
    diagnostics: "Diagnostics",
    logging: "Logging",
    gateway: "Gateway",
    nodeHost: "Node Host",
    agents: "Agents",
    tools: "Tools",
    bindings: "Bindings",
    audio: "Audio",
    models: "Models",
    messages: "Messages",
    commands: "Commands",
    session: "Session",
    cron: "Cron",
    hooks: "Hooks",
    ui: "UI",
    browser: "Browser",
    talk: "Talk",
    channels: "Messaging Channels",
    skills: "Skills",
    plugins: "Plugins",
    discovery: "Discovery",
    presence: "Presence",
    voicewake: "Voice Wake",
};
const GROUP_ORDER = {
    wizard: 20,
    update: 25,
    cli: 26,
    diagnostics: 27,
    gateway: 30,
    nodeHost: 35,
    agents: 40,
    tools: 50,
    bindings: 55,
    audio: 60,
    models: 70,
    messages: 80,
    commands: 85,
    session: 90,
    cron: 100,
    hooks: 110,
    ui: 120,
    browser: 130,
    talk: 140,
    channels: 150,
    skills: 200,
    plugins: 205,
    discovery: 210,
    presence: 220,
    voicewake: 230,
    logging: 900,
};
const FIELD_PLACEHOLDERS = {
    "gateway.remote.url": "ws://host:18789",
    "gateway.remote.tlsFingerprint": "sha256:ab12cd34…",
    "gateway.remote.sshTarget": "user@host",
    "gateway.controlUi.basePath": "/openclaw",
    "gateway.controlUi.root": "dist/control-ui",
    "gateway.controlUi.allowedOrigins": "https://control.example.com",
    "gateway.push.apns.relay.baseUrl": "https://relay.example.com",
    "channels.mattermost.baseUrl": "https://chat.example.com",
    "agents.list[].identity.avatar": "avatars/openclaw.png",
};
const CHANNEL_NAMESPACE_PREFIX = "channels.";
const CHANNEL_KERNEL_HINT_PREFIXES = ["channels.defaults", "channels.modelByChannel"];
function isKernelOwnedChannelHintPath(path) {
    if (path === "channels") {
        return true;
    }
    return CHANNEL_KERNEL_HINT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));
}
export function isPluginOwnedChannelHintPath(path) {
    if (!path.startsWith(CHANNEL_NAMESPACE_PREFIX)) {
        return false;
    }
    return !isKernelOwnedChannelHintPath(path);
}
export { isSensitiveConfigPath };
export function buildBaseHints() {
    const hints = {};
    for (const [group, label] of Object.entries(GROUP_LABELS)) {
        hints[group] = {
            label,
            group: label,
            order: GROUP_ORDER[group],
        };
    }
    for (const [path, label] of Object.entries(FIELD_LABELS)) {
        if (isPluginOwnedChannelHintPath(path)) {
            continue;
        }
        const current = hints[path];
        hints[path] = current ? { ...current, label } : { label };
    }
    for (const [path, help] of Object.entries(FIELD_HELP)) {
        if (isPluginOwnedChannelHintPath(path)) {
            continue;
        }
        const current = hints[path];
        hints[path] = current ? { ...current, help } : { help };
    }
    for (const [path, placeholder] of Object.entries(FIELD_PLACEHOLDERS)) {
        if (isPluginOwnedChannelHintPath(path)) {
            continue;
        }
        const current = hints[path];
        hints[path] = current ? { ...current, placeholder } : { placeholder };
    }
    return applyDerivedTags(hints);
}
export function applySensitiveHints(hints, allowedKeys) {
    const next = { ...hints };
    const keys = allowedKeys ? [...allowedKeys] : Object.keys(next);
    for (const key of keys) {
        const current = next[key];
        if (current?.sensitive !== undefined) {
            continue;
        }
        if (isSensitiveConfigPath(key)) {
            next[key] = { ...current, sensitive: true };
        }
    }
    return next;
}
export function applySensitiveUrlHints(hints, allowedKeys) {
    const next = { ...hints };
    const keys = allowedKeys ? [...allowedKeys] : Object.keys(next);
    for (const key of keys) {
        if (!isSensitiveUrlConfigPath(key)) {
            continue;
        }
        const current = next[key];
        const tags = new Set(current?.tags ?? []);
        tags.add(SENSITIVE_URL_HINT_TAG);
        next[key] = {
            ...current,
            tags: [...tags],
        };
    }
    return next;
}
export function collectMatchingSchemaPaths(schema, path, matchesPath, paths = new Set()) {
    let currentSchema = schema;
    while (isUnwrappable(currentSchema)) {
        currentSchema = currentSchema.unwrap();
    }
    if (path && matchesPath(path)) {
        paths.add(path);
    }
    if (currentSchema instanceof z.ZodObject) {
        const shape = currentSchema.shape;
        for (const key in shape) {
            const nextPath = path ? `${path}.${key}` : key;
            collectMatchingSchemaPaths(shape[key], nextPath, matchesPath, paths);
        }
        const catchallSchema = currentSchema._def.catchall;
        if (catchallSchema && !(catchallSchema instanceof z.ZodNever)) {
            const nextPath = path ? `${path}.*` : "*";
            collectMatchingSchemaPaths(catchallSchema, nextPath, matchesPath, paths);
        }
    }
    else if (currentSchema instanceof z.ZodArray) {
        const nextPath = path ? `${path}[]` : "[]";
        collectMatchingSchemaPaths(currentSchema.element, nextPath, matchesPath, paths);
    }
    else if (currentSchema instanceof z.ZodRecord) {
        const nextPath = path ? `${path}.*` : "*";
        collectMatchingSchemaPaths(currentSchema._def.valueType, nextPath, matchesPath, paths);
    }
    else if (currentSchema instanceof z.ZodUnion ||
        currentSchema instanceof z.ZodDiscriminatedUnion) {
        for (const option of currentSchema.options) {
            collectMatchingSchemaPaths(option, path, matchesPath, paths);
        }
    }
    else if (currentSchema instanceof z.ZodIntersection) {
        collectMatchingSchemaPaths(currentSchema._def.left, path, matchesPath, paths);
        collectMatchingSchemaPaths(currentSchema._def.right, path, matchesPath, paths);
    }
    return paths;
}
function isUnwrappable(object) {
    return (!!object &&
        typeof object === "object" &&
        "unwrap" in object &&
        typeof object.unwrap === "function" &&
        !(object instanceof z.ZodArray));
}
export function mapSensitivePaths(schema, path, hints) {
    let next = { ...hints };
    let currentSchema = schema;
    let isSensitive = sensitive.has(currentSchema);
    while (isUnwrappable(currentSchema)) {
        currentSchema = currentSchema.unwrap();
        isSensitive ||= sensitive.has(currentSchema);
    }
    if (isSensitive) {
        next[path] = { ...next[path], sensitive: true };
    }
    else if (isSensitiveConfigPath(path) && !next[path]?.sensitive) {
        getLog().debug(`possibly sensitive key found: (${path})`);
    }
    if (currentSchema instanceof z.ZodObject) {
        const shape = currentSchema.shape;
        for (const key in shape) {
            const nextPath = path ? `${path}.${key}` : key;
            next = mapSensitivePaths(shape[key], nextPath, next);
        }
        const catchallSchema = currentSchema._def.catchall;
        if (catchallSchema && !(catchallSchema instanceof z.ZodNever)) {
            const nextPath = path ? `${path}.*` : "*";
            next = mapSensitivePaths(catchallSchema, nextPath, next);
        }
    }
    else if (currentSchema instanceof z.ZodArray) {
        const nextPath = path ? `${path}[]` : "[]";
        next = mapSensitivePaths(currentSchema.element, nextPath, next);
    }
    else if (currentSchema instanceof z.ZodRecord) {
        const nextPath = path ? `${path}.*` : "*";
        next = mapSensitivePaths(currentSchema._def.valueType, nextPath, next);
    }
    else if (currentSchema instanceof z.ZodUnion ||
        currentSchema instanceof z.ZodDiscriminatedUnion) {
        for (const option of currentSchema.options) {
            next = mapSensitivePaths(option, path, next);
        }
    }
    else if (currentSchema instanceof z.ZodIntersection) {
        next = mapSensitivePaths(currentSchema._def.left, path, next);
        next = mapSensitivePaths(currentSchema._def.right, path, next);
    }
    return next;
}
/** @internal */
export const __test__ = {
    collectMatchingSchemaPaths,
    mapSensitivePaths,
};
