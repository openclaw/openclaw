export function applySessionStoreMigrations(store) {
    // Best-effort migration: message provider → channel naming.
    for (const entry of Object.values(store)) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        const rec = entry;
        if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
            rec.channel = rec.provider;
            delete rec.provider;
        }
        if (typeof rec.lastChannel !== "string" && typeof rec.lastProvider === "string") {
            rec.lastChannel = rec.lastProvider;
            delete rec.lastProvider;
        }
        // Best-effort migration: legacy `room` field → `groupChannel` (keep value, prune old key).
        if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
            rec.groupChannel = rec.room;
            delete rec.room;
        }
        else if ("room" in rec) {
            delete rec.room;
        }
    }
}
