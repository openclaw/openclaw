export function buildProfileQuery(profile) {
    return profile ? `?profile=${encodeURIComponent(profile)}` : "";
}
export function withBaseUrl(baseUrl, path) {
    const trimmed = baseUrl?.trim();
    if (!trimmed) {
        return path;
    }
    return `${trimmed.replace(/\/$/, "")}${path}`;
}
