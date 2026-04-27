export function stripUrlUserInfo(value) {
    try {
        const parsed = new URL(value);
        if (!parsed.username && !parsed.password) {
            return value;
        }
        parsed.username = "";
        parsed.password = "";
        return parsed.toString();
    }
    catch {
        return value;
    }
}
