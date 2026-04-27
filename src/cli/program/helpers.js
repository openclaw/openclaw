export function collectOption(value, previous = []) {
    return [...previous, value];
}
export function parsePositiveIntOrUndefined(value) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            return undefined;
        }
        const parsed = Math.trunc(value);
        return parsed > 0 ? parsed : undefined;
    }
    if (typeof value === "string") {
        const parsed = Number.parseInt(value, 10);
        if (Number.isNaN(parsed) || parsed <= 0) {
            return undefined;
        }
        return parsed;
    }
    return undefined;
}
export function resolveActionArgs(actionCommand) {
    if (!actionCommand) {
        return [];
    }
    const args = actionCommand.args;
    return Array.isArray(args) ? args : [];
}
