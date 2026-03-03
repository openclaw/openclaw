export function escapeSlackMrkdwn(value) {
    return value
        .replaceAll("\\", "\\\\")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replace(/([*_`~])/g, "\\$1");
}
