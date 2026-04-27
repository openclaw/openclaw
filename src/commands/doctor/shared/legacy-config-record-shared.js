import { isRecord } from "../../../utils.js";
export { isRecord };
export function cloneRecord(value) {
    return { ...value };
}
export function ensureRecord(target, key) {
    const current = target[key];
    if (isRecord(current)) {
        return current;
    }
    const next = {};
    target[key] = next;
    return next;
}
export function hasOwnKey(target, key) {
    return Object.prototype.hasOwnProperty.call(target, key);
}
