const ARCHIVE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/;
const LEGACY_STORE_BACKUP_RE = /^sessions\.json\.bak\.\d+$/;
function hasArchiveSuffix(fileName, reason) {
    const marker = `.${reason}.`;
    const index = fileName.lastIndexOf(marker);
    if (index < 0) {
        return false;
    }
    const raw = fileName.slice(index + marker.length);
    return ARCHIVE_TIMESTAMP_RE.test(raw);
}
export function isSessionArchiveArtifactName(fileName) {
    if (LEGACY_STORE_BACKUP_RE.test(fileName)) {
        return true;
    }
    return (hasArchiveSuffix(fileName, "deleted") ||
        hasArchiveSuffix(fileName, "reset") ||
        hasArchiveSuffix(fileName, "bak"));
}
export function isPrimarySessionTranscriptFileName(fileName) {
    if (fileName === "sessions.json") {
        return false;
    }
    if (!fileName.endsWith(".jsonl")) {
        return false;
    }
    return !isSessionArchiveArtifactName(fileName);
}
export function formatSessionArchiveTimestamp(nowMs = Date.now()) {
    return new Date(nowMs).toISOString().replaceAll(":", "-");
}
function restoreSessionArchiveTimestamp(raw) {
    const [datePart, timePart] = raw.split("T");
    if (!datePart || !timePart) {
        return raw;
    }
    return `${datePart}T${timePart.replace(/-/g, ":")}`;
}
export function parseSessionArchiveTimestamp(fileName, reason) {
    const marker = `.${reason}.`;
    const index = fileName.lastIndexOf(marker);
    if (index < 0) {
        return null;
    }
    const raw = fileName.slice(index + marker.length);
    if (!raw) {
        return null;
    }
    if (!ARCHIVE_TIMESTAMP_RE.test(raw)) {
        return null;
    }
    const timestamp = Date.parse(restoreSessionArchiveTimestamp(raw));
    return Number.isNaN(timestamp) ? null : timestamp;
}
