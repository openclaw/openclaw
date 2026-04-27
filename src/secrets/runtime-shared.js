import { coerceSecretRef } from "../config/types.secrets.js";
import { secretRefKey } from "./ref-contract.js";
import { assertExpectedResolvedSecretValue } from "./secret-value.js";
import { isRecord } from "./shared.js";
export function createResolverContext(params) {
    return {
        sourceConfig: params.sourceConfig,
        env: params.env,
        cache: {},
        warnings: [],
        warningKeys: new Set(),
        assignments: [],
    };
}
export function pushAssignment(context, assignment) {
    context.assignments.push(assignment);
}
export function pushWarning(context, warning) {
    const warningKey = `${warning.code}:${warning.path}:${warning.message}`;
    if (context.warningKeys.has(warningKey)) {
        return;
    }
    context.warningKeys.add(warningKey);
    context.warnings.push(warning);
}
export function pushInactiveSurfaceWarning(params) {
    pushWarning(params.context, {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: params.path,
        message: params.details && params.details.trim().length > 0
            ? `${params.path}: ${params.details}`
            : `${params.path}: secret ref is configured on an inactive surface; skipping resolution until it becomes active.`,
    });
}
export function collectSecretInputAssignment(params) {
    const ref = coerceSecretRef(params.value, params.defaults);
    if (!ref) {
        return;
    }
    if (params.active === false) {
        pushInactiveSurfaceWarning({
            context: params.context,
            path: params.path,
            details: params.inactiveReason,
        });
        return;
    }
    pushAssignment(params.context, {
        ref,
        path: params.path,
        expected: params.expected,
        apply: params.apply,
    });
}
export function applyResolvedAssignments(params) {
    for (const assignment of params.assignments) {
        const key = secretRefKey(assignment.ref);
        if (!params.resolved.has(key)) {
            throw new Error(`Secret reference "${key}" resolved to no value.`);
        }
        const value = params.resolved.get(key);
        assertExpectedResolvedSecretValue({
            value,
            expected: assignment.expected,
            errorMessage: assignment.expected === "string"
                ? `${assignment.path} resolved to a non-string or empty value.`
                : `${assignment.path} resolved to an unsupported value type.`,
        });
        assignment.apply(value);
    }
}
export function hasOwnProperty(record, key) {
    return Object.prototype.hasOwnProperty.call(record, key);
}
export function isEnabledFlag(value) {
    if (!isRecord(value)) {
        return true;
    }
    return value.enabled !== false;
}
export function isChannelAccountEffectivelyEnabled(channel, account) {
    return isEnabledFlag(channel) && isEnabledFlag(account);
}
