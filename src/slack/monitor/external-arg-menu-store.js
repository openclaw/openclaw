import { generateSecureToken } from "../../infra/secure-random.js";
const SLACK_EXTERNAL_ARG_MENU_TOKEN_BYTES = 18;
const SLACK_EXTERNAL_ARG_MENU_TOKEN_LENGTH = Math.ceil((SLACK_EXTERNAL_ARG_MENU_TOKEN_BYTES * 8) / 6);
const SLACK_EXTERNAL_ARG_MENU_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${SLACK_EXTERNAL_ARG_MENU_TOKEN_LENGTH}}$`);
const SLACK_EXTERNAL_ARG_MENU_TTL_MS = 10 * 60 * 1000;
export const SLACK_EXTERNAL_ARG_MENU_PREFIX = "openclaw_cmdarg_ext:";
function pruneSlackExternalArgMenuStore(store, now) {
    for (const [token, entry] of store.entries()) {
        if (entry.expiresAt <= now) {
            store.delete(token);
        }
    }
}
function createSlackExternalArgMenuToken(store) {
    let token = "";
    do {
        token = generateSecureToken(SLACK_EXTERNAL_ARG_MENU_TOKEN_BYTES);
    } while (store.has(token));
    return token;
}
export function createSlackExternalArgMenuStore() {
    const store = new Map();
    return {
        create(params, now = Date.now()) {
            pruneSlackExternalArgMenuStore(store, now);
            const token = createSlackExternalArgMenuToken(store);
            store.set(token, {
                choices: params.choices,
                userId: params.userId,
                expiresAt: now + SLACK_EXTERNAL_ARG_MENU_TTL_MS,
            });
            return token;
        },
        readToken(raw) {
            if (typeof raw !== "string" || !raw.startsWith(SLACK_EXTERNAL_ARG_MENU_PREFIX)) {
                return undefined;
            }
            const token = raw.slice(SLACK_EXTERNAL_ARG_MENU_PREFIX.length).trim();
            return SLACK_EXTERNAL_ARG_MENU_TOKEN_PATTERN.test(token) ? token : undefined;
        },
        get(token, now = Date.now()) {
            pruneSlackExternalArgMenuStore(store, now);
            return store.get(token);
        },
    };
}
