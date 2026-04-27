export function skipDirectiveArgPrefix(raw) {
    let i = 0;
    const len = raw.length;
    while (i < len && /\s/.test(raw[i])) {
        i += 1;
    }
    if (raw[i] === ":") {
        i += 1;
        while (i < len && /\s/.test(raw[i])) {
            i += 1;
        }
    }
    return i;
}
export function takeDirectiveToken(raw, startIndex) {
    let i = startIndex;
    const len = raw.length;
    while (i < len && /\s/.test(raw[i])) {
        i += 1;
    }
    if (i >= len) {
        return { token: null, nextIndex: i };
    }
    const start = i;
    while (i < len && !/\s/.test(raw[i])) {
        i += 1;
    }
    if (start === i) {
        return { token: null, nextIndex: i };
    }
    const token = raw.slice(start, i);
    while (i < len && /\s/.test(raw[i])) {
        i += 1;
    }
    return { token, nextIndex: i };
}
