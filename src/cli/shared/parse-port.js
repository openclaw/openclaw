import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";
export function parsePort(raw) {
    if (raw === undefined || raw === null) {
        return null;
    }
    return parseStrictPositiveInteger(raw) ?? null;
}
