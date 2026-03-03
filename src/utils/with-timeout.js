export function withTimeout(promise, timeoutMs) {
    if (!timeoutMs || timeoutMs <= 0) {
        return promise;
    }
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) {
            clearTimeout(timer);
        }
    });
}
