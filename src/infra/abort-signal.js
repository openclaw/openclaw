export async function waitForAbortSignal(signal) {
    if (!signal || signal.aborted) {
        return;
    }
    await new Promise((resolve) => {
        const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
