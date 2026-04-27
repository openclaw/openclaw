import { Writable } from "node:stream";
import { defaultRuntime } from "../../runtime.js";
export function emitDaemonActionJson(payload) {
    defaultRuntime.writeJson(payload);
}
function classifyDaemonHintText(text) {
    if (text.includes("openclaw gateway install") || text.startsWith("Service not installed. Run:")) {
        return "install";
    }
    if (text.startsWith("Restart the container or the service that manages it for ")) {
        return "container-restart";
    }
    if (text.startsWith("systemd user services are unavailable;")) {
        return "systemd-unavailable";
    }
    if (text.startsWith("On a headless server (SSH/no desktop session):") ||
        text.startsWith("Also ensure XDG_RUNTIME_DIR is set:")) {
        return "systemd-headless";
    }
    if (text.startsWith("If you're in a container, run the gateway in the foreground instead of")) {
        return "container-foreground";
    }
    if (text.startsWith("WSL2 needs systemd enabled:") ||
        text.startsWith("Then run: wsl --shutdown") ||
        text.startsWith("Verify: systemctl --user status")) {
        return "wsl-systemd";
    }
    return "generic";
}
export function buildDaemonHintItems(hints) {
    if (!hints?.length) {
        return undefined;
    }
    return hints.map((text) => ({ kind: classifyDaemonHintText(text), text }));
}
export function buildDaemonServiceSnapshot(service, loaded) {
    return {
        label: service.label,
        loaded,
        loadedText: service.loadedText,
        notLoadedText: service.notLoadedText,
    };
}
export function createNullWriter() {
    return new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        },
    });
}
export function createDaemonActionContext(params) {
    const warnings = [];
    const stdout = params.json ? createNullWriter() : process.stdout;
    const emit = (payload) => {
        if (!params.json) {
            return;
        }
        emitDaemonActionJson({
            action: params.action,
            ...payload,
            hintItems: payload.hintItems ?? buildDaemonHintItems(payload.hints),
            warnings: payload.warnings ?? (warnings.length ? warnings : undefined),
        });
    };
    const fail = (message, hints) => {
        if (params.json) {
            emit({
                ok: false,
                error: message,
                hints,
            });
        }
        else {
            defaultRuntime.error(message);
            if (hints?.length) {
                for (const hint of hints) {
                    defaultRuntime.log(`Tip: ${hint}`);
                }
            }
        }
        defaultRuntime.exit(1);
    };
    return { stdout, warnings, emit, fail };
}
export async function installDaemonServiceAndEmit(params) {
    try {
        await params.install();
    }
    catch (err) {
        params.fail(`${params.serviceNoun} install failed: ${String(err)}`);
        return;
    }
    let installed = true;
    try {
        installed = await params.service.isLoaded({ env: process.env });
    }
    catch {
        installed = true;
    }
    params.emit({
        ok: true,
        result: "installed",
        service: buildDaemonServiceSnapshot(params.service, installed),
        warnings: params.warnings.length ? params.warnings : undefined,
    });
}
