import { normalizeOptionalString } from "./string-coerce.js";
export function resolveEmojiAndHomepage(params) {
    const emoji = params.metadata?.emoji ?? params.frontmatter?.emoji;
    const homepageRaw = params.metadata?.homepage ??
        params.frontmatter?.homepage ??
        params.frontmatter?.website ??
        params.frontmatter?.url;
    const homepage = normalizeOptionalString(homepageRaw);
    return { ...(emoji ? { emoji } : {}), ...(homepage ? { homepage } : {}) };
}
