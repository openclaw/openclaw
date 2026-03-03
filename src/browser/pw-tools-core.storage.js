import { ensurePageState, getPageForTargetId } from "./pw-session.js";
export async function cookiesGetViaPlaywright(opts) {
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    const cookies = await page.context().cookies();
    return { cookies };
}
export async function cookiesSetViaPlaywright(opts) {
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    const cookie = opts.cookie;
    if (!cookie.name || cookie.value === undefined) {
        throw new Error("cookie name and value are required");
    }
    const hasUrl = typeof cookie.url === "string" && cookie.url.trim();
    const hasDomainPath = typeof cookie.domain === "string" &&
        cookie.domain.trim() &&
        typeof cookie.path === "string" &&
        cookie.path.trim();
    if (!hasUrl && !hasDomainPath) {
        throw new Error("cookie requires url, or domain+path");
    }
    await page.context().addCookies([cookie]);
}
export async function cookiesClearViaPlaywright(opts) {
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    await page.context().clearCookies();
}
export async function storageGetViaPlaywright(opts) {
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    const kind = opts.kind;
    const key = typeof opts.key === "string" ? opts.key : undefined;
    const values = await page.evaluate(({ kind: kind2, key: key2 }) => {
        const store = kind2 === "session" ? window.sessionStorage : window.localStorage;
        if (key2) {
            const value = store.getItem(key2);
            return value === null ? {} : { [key2]: value };
        }
        const out = {};
        for (let i = 0; i < store.length; i += 1) {
            const k = store.key(i);
            if (!k) {
                continue;
            }
            const v = store.getItem(k);
            if (v !== null) {
                out[k] = v;
            }
        }
        return out;
    }, { kind, key });
    return { values: values ?? {} };
}
export async function storageSetViaPlaywright(opts) {
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    const key = String(opts.key ?? "");
    if (!key) {
        throw new Error("key is required");
    }
    await page.evaluate(({ kind, key: k, value }) => {
        const store = kind === "session" ? window.sessionStorage : window.localStorage;
        store.setItem(k, value);
    }, { kind: opts.kind, key, value: String(opts.value ?? "") });
}
export async function storageClearViaPlaywright(opts) {
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    await page.evaluate(({ kind }) => {
        const store = kind === "session" ? window.sessionStorage : window.localStorage;
        store.clear();
    }, { kind: opts.kind });
}
