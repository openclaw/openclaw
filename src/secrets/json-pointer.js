function failOrUndefined(params) {
    if (params.onMissing === "throw") {
        throw new Error(params.message);
    }
    return undefined;
}
export function decodeJsonPointerToken(token) {
    return token.replace(/~1/g, "/").replace(/~0/g, "~");
}
export function encodeJsonPointerToken(token) {
    return token.replace(/~/g, "~0").replace(/\//g, "~1");
}
export function readJsonPointer(root, pointer, options = {}) {
    const onMissing = options.onMissing ?? "throw";
    if (!pointer.startsWith("/")) {
        return failOrUndefined({
            onMissing,
            message: 'File-backed secret ids must be absolute JSON pointers (for example: "/providers/openai/apiKey").',
        });
    }
    const tokens = pointer
        .slice(1)
        .split("/")
        .map((token) => decodeJsonPointerToken(token));
    let current = root;
    for (const token of tokens) {
        if (Array.isArray(current)) {
            const index = Number.parseInt(token, 10);
            if (!Number.isFinite(index) || index < 0 || index >= current.length) {
                return failOrUndefined({
                    onMissing,
                    message: `JSON pointer segment "${token}" is out of bounds.`,
                });
            }
            current = current[index];
            continue;
        }
        if (typeof current !== "object" || current === null || Array.isArray(current)) {
            return failOrUndefined({
                onMissing,
                message: `JSON pointer segment "${token}" does not exist.`,
            });
        }
        const record = current;
        if (!Object.hasOwn(record, token)) {
            return failOrUndefined({
                onMissing,
                message: `JSON pointer segment "${token}" does not exist.`,
            });
        }
        current = record[token];
    }
    return current;
}
export function setJsonPointer(root, pointer, value) {
    if (!pointer.startsWith("/")) {
        throw new Error(`Invalid JSON pointer "${pointer}".`);
    }
    const tokens = pointer
        .slice(1)
        .split("/")
        .map((token) => decodeJsonPointerToken(token));
    let current = root;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        const isLast = index === tokens.length - 1;
        if (isLast) {
            current[token] = value;
            return;
        }
        const child = current[token];
        if (typeof child !== "object" || child === null || Array.isArray(child)) {
            current[token] = {};
        }
        current = current[token];
    }
}
