import type { ChildProcess } from "node:child_process";

const MAX_RECORDS = 48;
const label = (value: string) => value.slice(0, 96);

type ChildObservation = Pick<ChildProcess, "pid" | "exitCode" | "signalCode"> & {
  stdout: { closed: boolean } | null;
  stderr: { closed: boolean } | null;
  once(event: "spawn" | "exit" | "close", listener: () => void): unknown;
};

/** Failure-only metadata; never retain command arguments, environment, paths, or output. */
export function createFixtureDiagnostics(name: string) {
  const startedAt = performance.now();
  const records: object[] = [];
  let dropped = 0;
  let sequence = 0;
  let stage = "setup";
  let reported = false;
  let current: (() => object) | undefined;
  const elapsed = () => Math.round(performance.now() - startedAt);
  const record = (value: object) => {
    if (records.length === MAX_RECORDS) {
      records.shift();
      dropped++;
    }
    records.push(value);
  };

  return {
    stage(value: string) {
      stage = label(value);
      record({ event: "stage", stage, elapsedMs: elapsed() });
    },
    command(role: string, hasInput = false) {
      const commandStartedAt = performance.now();
      const id = ++sequence;
      const commandStage = stage;
      const commandRole = label(role);
      let child: ChildObservation | undefined;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let input = hasInput ? "pending" : "not-applicable";
      let errorCode: string | undefined;
      const snapshot = (event: string) => ({
        event,
        id,
        role: commandRole,
        stage: commandStage,
        elapsedMs: elapsed(),
        commandElapsedMs: Math.round(performance.now() - commandStartedAt),
        pid: child?.pid,
        exitCode: child?.exitCode,
        signalCode: child?.signalCode,
        stdoutClosed: child?.stdout?.closed,
        stderrClosed: child?.stderr?.closed,
        stdoutBytes,
        stderrBytes,
        input,
        errorCode,
      });
      const event = (value: string) => record(snapshot(value));
      current = () => snapshot("current");
      event("command-start");
      return {
        ready(value: ChildObservation) {
          child = value;
          event("on-ready");
          // The owner installs capture and lifecycle handlers first. These only observe.
          for (const eventName of ["spawn", "exit", "close"] as const) {
            child.once(eventName, () => event(eventName));
          }
        },
        output(stream: "stdout" | "stderr", bytes: number) {
          if (stream === "stdout") {
            stdoutBytes += bytes;
          } else {
            stderrBytes += bytes;
          }
        },
        settled(error?: unknown) {
          if (error && typeof error === "object" && "code" in error) {
            const code = error.code;
            if (typeof code === "string" && /^[A-Z_0-9]{1,48}$/u.test(code)) {
              errorCode = code;
            }
          }
          event("managed-settled");
        },
        inputComplete() {
          if (hasInput) {
            input = "settled";
          }
          event("input-complete");
        },
      };
    },
    report(reason: "failure" | "abort") {
      if (reported) {
        return;
      }
      reported = true;
      console.error(
        "[fixture-lifecycle] " +
          JSON.stringify({
            name: label(name),
            reason,
            stage,
            dropped,
            records,
            current: current?.(),
          }),
      );
    },
  };
}

export type FixtureDiagnostics = ReturnType<typeof createFixtureDiagnostics>;
