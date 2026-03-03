import { normalizeOptionalAccountId } from "../routing/account-id.js";
export function normalizeAccountId(value) {
    return normalizeOptionalAccountId(value);
}
