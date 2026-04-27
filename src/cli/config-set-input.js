import fs from "node:fs";
import JSON5 from "json5";
import { normalizeOptionalString, normalizeStringifiedOptionalString, } from "../shared/string-coerce.js";
export function hasBatchMode(opts) {
    return Boolean(normalizeOptionalString(opts.batchJson) || normalizeOptionalString(opts.batchFile));
}
export function hasRefBuilderOptions(opts) {
    return Boolean(opts.refProvider || opts.refSource || opts.refId);
}
export function hasProviderBuilderOptions(opts) {
    return Boolean(opts.providerSource ||
        opts.providerAllowlist?.length ||
        opts.providerPath ||
        opts.providerMode ||
        opts.providerTimeoutMs ||
        opts.providerMaxBytes ||
        opts.providerCommand ||
        opts.providerArg?.length ||
        opts.providerNoOutputTimeoutMs ||
        opts.providerMaxOutputBytes ||
        opts.providerJsonOnly ||
        opts.providerEnv?.length ||
        opts.providerPassEnv?.length ||
        opts.providerTrustedDir?.length ||
        opts.providerAllowInsecurePath ||
        opts.providerAllowSymlinkCommand);
}
function parseJson5Raw(raw, label) {
    try {
        return JSON5.parse(raw);
    }
    catch (err) {
        throw new Error(`Failed to parse ${label}: ${String(err)}`, { cause: err });
    }
}
function parseBatchEntries(raw, sourceLabel) {
    const parsed = parseJson5Raw(raw, sourceLabel);
    if (!Array.isArray(parsed)) {
        throw new Error(`${sourceLabel} must be a JSON array.`);
    }
    const out = [];
    for (const [index, entry] of parsed.entries()) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error(`${sourceLabel}[${index}] must be an object.`);
        }
        const typed = entry;
        const path = normalizeOptionalString(typed.path) ?? "";
        if (!path) {
            throw new Error(`${sourceLabel}[${index}].path is required.`);
        }
        const hasValue = Object.prototype.hasOwnProperty.call(typed, "value");
        const hasRef = Object.prototype.hasOwnProperty.call(typed, "ref");
        const hasProvider = Object.prototype.hasOwnProperty.call(typed, "provider");
        const modeCount = Number(hasValue) + Number(hasRef) + Number(hasProvider);
        if (modeCount !== 1) {
            throw new Error(`${sourceLabel}[${index}] must include exactly one of: value, ref, provider.`);
        }
        out.push({
            path,
            ...(hasValue ? { value: typed.value } : {}),
            ...(hasRef ? { ref: typed.ref } : {}),
            ...(hasProvider ? { provider: typed.provider } : {}),
        });
    }
    return out;
}
export function parseBatchSource(opts) {
    const batchJson = normalizeOptionalString(opts.batchJson);
    const batchFile = normalizeOptionalString(opts.batchFile);
    const hasInline = Boolean(batchJson);
    const hasFile = Boolean(batchFile);
    if (!hasInline && !hasFile) {
        return null;
    }
    if (hasInline && hasFile) {
        throw new Error("Use either --batch-json or --batch-file, not both.");
    }
    if (hasInline) {
        return parseBatchEntries(batchJson, "--batch-json");
    }
    const pathname = normalizeStringifiedOptionalString(opts.batchFile) ?? "";
    if (!pathname) {
        throw new Error("--batch-file must not be empty.");
    }
    const raw = fs.readFileSync(pathname, "utf8");
    return parseBatchEntries(raw, "--batch-file");
}
