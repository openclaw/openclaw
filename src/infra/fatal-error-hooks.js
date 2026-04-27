const hooks = new Set();
function formatHookFailure(error) {
    const name = error instanceof Error && error.name ? error.name : "unknown";
    return `fatal-error hook failed: ${name}`;
}
export function registerFatalErrorHook(hook) {
    hooks.add(hook);
    return () => {
        hooks.delete(hook);
    };
}
export function runFatalErrorHooks(context) {
    const messages = [];
    for (const hook of hooks) {
        try {
            const message = hook(context);
            if (typeof message === "string" && message.trim()) {
                messages.push(message);
            }
        }
        catch (err) {
            messages.push(formatHookFailure(err));
        }
    }
    return messages;
}
export function resetFatalErrorHooksForTest() {
    hooks.clear();
}
