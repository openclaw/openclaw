import fs from "node:fs";
import { z } from "zod";
import { safeParseJsonWithSchema } from "../../utils/zod-parse.js";
const SessionStoreSchema = z.record(z.string(), z.unknown());
export function readSessionStoreReadOnly(storePath) {
    try {
        const raw = fs.readFileSync(storePath, "utf-8");
        if (!raw.trim()) {
            return {};
        }
        return safeParseJsonWithSchema(SessionStoreSchema, raw) ?? {};
    }
    catch {
        return {};
    }
}
