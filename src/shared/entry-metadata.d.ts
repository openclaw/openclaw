export declare function resolveEmojiAndHomepage(params: {
    metadata?: {
        emoji?: string;
        homepage?: string;
    } | null;
    frontmatter?: {
        emoji?: string;
        homepage?: string;
        website?: string;
        url?: string;
    } | null;
}): {
    emoji?: string;
    homepage?: string;
};
