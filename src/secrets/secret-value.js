import { isNonEmptyString, isRecord } from "./shared.js";
export function isExpectedResolvedSecretValue(value, expected) {
    if (expected === "string") {
        return isNonEmptyString(value);
    }
    return isNonEmptyString(value) || isRecord(value);
}
export function hasConfiguredPlaintextSecretValue(value, expected) {
    if (expected === "string") {
        return isNonEmptyString(value);
    }
    return isNonEmptyString(value) || (isRecord(value) && Object.keys(value).length > 0);
}
export function assertExpectedResolvedSecretValue(params) {
    if (!isExpectedResolvedSecretValue(params.value, params.expected)) {
        throw new Error(params.errorMessage);
    }
}
