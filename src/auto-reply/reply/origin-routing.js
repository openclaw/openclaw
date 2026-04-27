import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
export function resolveOriginMessageProvider(params) {
    return (normalizeOptionalLowercaseString(params.originatingChannel) ??
        normalizeOptionalLowercaseString(params.provider));
}
export function resolveOriginMessageTo(params) {
    return params.originatingTo ?? params.to;
}
export function resolveOriginAccountId(params) {
    return params.originatingAccountId ?? params.accountId;
}
