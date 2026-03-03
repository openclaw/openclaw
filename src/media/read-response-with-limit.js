export async function readResponseWithLimit(res, maxBytes, opts) {
    const onOverflow = opts?.onOverflow ??
        ((params) => new Error(`Content too large: ${params.size} bytes (limit: ${params.maxBytes} bytes)`));
    const body = res.body;
    if (!body || typeof body.getReader !== "function") {
        const fallback = Buffer.from(await res.arrayBuffer());
        if (fallback.length > maxBytes) {
            throw onOverflow({ size: fallback.length, maxBytes, res });
        }
        return fallback;
    }
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (value?.length) {
                total += value.length;
                if (total > maxBytes) {
                    try {
                        await reader.cancel();
                    }
                    catch { }
                    throw onOverflow({ size: total, maxBytes, res });
                }
                chunks.push(value);
            }
        }
    }
    finally {
        try {
            reader.releaseLock();
        }
        catch { }
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}
