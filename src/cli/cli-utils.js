import { formatErrorMessage } from "../infra/errors.js";
export { formatErrorMessage };
export async function withManager(params) {
    const { manager, error } = await params.getManager();
    if (!manager) {
        params.onMissing(error);
        return;
    }
    try {
        await params.run(manager);
    }
    finally {
        try {
            await params.close(manager);
        }
        catch (err) {
            params.onCloseError?.(err);
        }
    }
}
export async function runCommandWithRuntime(runtime, action, onError) {
    try {
        await action();
    }
    catch (err) {
        if (onError) {
            onError(err);
            return;
        }
        runtime.error(String(err));
        runtime.exit(1);
    }
}
export function resolveOptionFromCommand(command, key) {
    let current = command;
    while (current) {
        const opts = current.opts?.() ?? {};
        if (opts[key] !== undefined) {
            return opts[key];
        }
        current = current.parent ?? undefined;
    }
    return undefined;
}
