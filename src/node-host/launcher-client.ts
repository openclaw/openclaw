// Node runtime messages to the process that owns executable selection and restart.
const CHILD_MARKER = Symbol.for("openclaw.node-host.launcher-child");
const MANAGED_STATE_MARKER = Symbol.for("openclaw.node-host.managed-state-path");

/** A companion retains stdin's write end; EOF also retires the node after an app crash. */
export function watchNodeHostParentStdin(onClose: () => void): () => void {
  const input = process.stdin;
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      onClose();
    }
  };
  input.once("end", close);
  input.once("error", close);
  input.once("close", close);
  input.resume();
  if (input.readableEnded || input.destroyed) {
    queueMicrotask(close);
  }
  return () => {
    closed = true;
    input.off("end", close);
    input.off("error", close);
    input.off("close", close);
    input.pause();
  };
}

export function isNodeHostLauncherChild(): boolean {
  return Reflect.get(process, CHILD_MARKER) === true && process.connected;
}

export function getManagedNodeHostStatePath(): string | undefined {
  if (!isNodeHostLauncherChild()) {
    return undefined;
  }
  const path: unknown = Reflect.get(process, MANAGED_STATE_MARKER);
  return typeof path === "string" ? path : undefined;
}

function sendLauncherMessage(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isNodeHostLauncherChild() || !process.send) {
      reject(new Error("The node runtime has no connected update supervisor."));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

export async function notifyNodeHostLauncherReady(version: string): Promise<void> {
  if (isNodeHostLauncherChild()) {
    await sendLauncherMessage({ type: "openclaw.node.ready", version });
  }
}

export async function setNodeHostLauncherRestartArguments(argv: string[]): Promise<void> {
  if (isNodeHostLauncherChild()) {
    await sendLauncherMessage({ type: "openclaw.node.restart-args", argv });
  }
}

export function requestNodeHostLauncherBootstrap(params: {
  execArgv: string[];
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  return requestLauncherReply(
    { type: "openclaw.node.bootstrap", ...params },
    "openclaw.node.bootstrap-result",
  );
}

export function requestNodeHostLauncherRestart(params: {
  runtimeRoot: string;
  version: string;
}): Promise<void> {
  return requestLauncherReply(
    { type: "openclaw.node.restart", ...params },
    "openclaw.node.restart-result",
  );
}

function requestLauncherReply(request: object, responseType: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      process.channel?.unref();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onDisconnect = () => fail(new Error("The node update supervisor disconnected."));
    const onMessage = (message: unknown) => {
      if (
        !message ||
        typeof message !== "object" ||
        !("type" in message) ||
        message.type !== responseType
      ) {
        return;
      }
      cleanup();
      if ("ok" in message && message.ok === true) {
        resolve();
      } else {
        reject(
          new Error(
            "error" in message && typeof message.error === "string"
              ? message.error
              : "The node update supervisor rejected the restart.",
          ),
        );
      }
    };
    const timer = setTimeout(
      () => fail(new Error("The node update supervisor did not acknowledge the restart.")),
      30_000,
    );
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    void sendLauncherMessage(request).catch(fail);
  });
}
