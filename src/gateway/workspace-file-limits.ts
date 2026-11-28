/** Shared preview cap for workspace readers and staged worker results. */
export const WORKSPACE_PREVIEW_MAX_BYTES = 256 * 1024;

/**
 * Image previews bypass the text preview cap but stay far below the 25 MB WS
 * payload limit even after base64 expansion (matches agents-workspace.ts).
 */
export const WORKSPACE_IMAGE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

/** Base64 windows stay below the 2 MiB workspace inspection envelope. */
export const WORKSPACE_DOWNLOAD_CHUNK_BYTES = 512 * 1024;
