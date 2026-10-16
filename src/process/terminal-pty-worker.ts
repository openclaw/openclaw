import type { TerminalPtyControl, TerminalPtyEvent } from "./terminal-pty-protocol.js";
import { prepareTerminalPty, spawnTerminalPty, type TerminalPtyHandle } from "./terminal-pty.js";

let pty: TerminalPtyHandle | undefined;
let starting = false;
let parentLost = false;
let finished = false;
let authorizeLaunch: (() => void) | undefined;

function report(message: TerminalPtyEvent, done?: () => void): void {
  if (!process.connected) {
    done?.();
    return;
  }
  process.send?.(message, () => done?.());
}

function finish(message: TerminalPtyEvent): void {
  if (finished) {
    return;
  }
  finished = true;
  pty?.kill();
  process.stdout.end(() => {
    report(message, () => {
      if (process.connected) {
        process.disconnect?.();
      }
    });
  });
}

function close(): void {
  parentLost = true;
  pty?.kill();
}

process.once("disconnect", close);
process.once("SIGTERM", close);
process.once("SIGINT", close);
process.stdout.on("error", close);
process.stdout.on("drain", () => pty?.resume());
// Only the spawning host writes this channel; launch authority is checked separately.
process.on("message", (message: TerminalPtyControl) => {
  if (message.type === "start" || message.type === "prepare") {
    if (starting || parentLost) {
      return;
    }
    starting = true;
    if (process.versions.bun) {
      finish({
        type: "error",
        message: "Terminal worker requires Node; PATH resolves node to Bun.",
      });
      return;
    }
    const startup =
      message.type === "prepare"
        ? prepareTerminalPty(message.params).then(
            (launch) =>
              new Promise<TerminalPtyHandle>((resolve, reject) => {
                authorizeLaunch = () => {
                  try {
                    if (parentLost || finished) {
                      throw new Error("Terminal host retired before launch");
                    }
                    resolve(launch());
                  } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                  }
                };
                report({ type: "prepared" });
              }),
          )
        : spawnTerminalPty(message.params);
    void startup.then(
      (handle) => {
        pty = handle;
        pty.onData((data) => {
          if (!process.stdout.write(data)) {
            handle.pause();
          }
        });
        pty.onExit((event) => finish({ type: "exit", ...event }));
        if (parentLost || finished) {
          pty.kill();
        } else {
          report({ type: "ready", pid: pty.pid });
        }
      },
      (error: unknown) =>
        finish({ type: "error", message: error instanceof Error ? error.message : String(error) }),
    );
  } else if (message.type === "launch") {
    const launch = authorizeLaunch;
    authorizeLaunch = undefined;
    launch?.();
  } else if (message.type === "input") {
    pty?.write("data" in message ? message.data : Buffer.from(message.dataBase64, "base64"));
  } else if (message.type === "resize") {
    pty?.resize(message.cols, message.rows);
  } else {
    pty?.kill(message.signal);
  }
});

// A source loader can yield before installing the IPC listener; admit starts only now.
report({ type: "boot" });
