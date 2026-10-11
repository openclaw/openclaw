import type { ChildProcess } from "node:child_process";

/** Observe immediately after spawn, before this owner can disconnect or transfer pipes. */
export function waitForBrokerChildCompletion(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    let exited = child.exitCode != null || child.signalCode != null;
    let ipcClosed = !child.connected;
    let openPipes = 0;
    const finish = () => {
      if (!exited || !ipcClosed || openPipes !== 0) {
        return;
      }
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      child.removeListener("disconnect", onDisconnect);
      resolve();
    };
    const onExit = () => {
      exited = true;
      finish();
    };
    const onError = () => {
      // Signal and IPC errors do not settle a live PID; failed spawn has no native child.
      if (child.pid === undefined) {
        exited = true;
        ipcClosed = true;
        finish();
      }
    };
    const onDisconnect = () => {
      ipcClosed = true;
      finish();
    };
    child.once("exit", onExit);
    child.on("error", onError);
    child.once("disconnect", onDisconnect);
    // Parent-side IPC disconnect can suppress Node's aggregate ChildProcess.close.
    // Join its public native receipts instead; transferred remote pipes have their own owner.
    for (const stream of child.stdio ?? []) {
      if (!stream || stream.closed) {
        continue;
      }
      openPipes++;
      stream.once("close", () => {
        openPipes--;
        finish();
      });
    }
    finish();
  });
}
