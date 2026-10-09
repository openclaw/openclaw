import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { HandoffNativeLifetime } from "./update-managed-service-handoff-schema.js";

/** Inspect the native scope through the same captured service-manager environment. */
export function createManagedHandoffScopeReader(serviceManagerEnv: NodeJS.ProcessEnv) {
  const control = (command: string, args: string[], timeout = 5000) =>
    spawnSync(command, args, {
      env: serviceManagerEnv,
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  function properties(stdout: string | Buffer | null | undefined): Record<string, string> {
    return Object.fromEntries(
      String(stdout || "")
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
  }
  function nativeScope(life: HandoffNativeLifetime) {
    const result = control("systemctl", [
      "--user",
      "show",
      life.scope,
      "--property=Id,LoadState,ActiveState,InvocationID,ControlGroup",
    ]);
    const scope = properties(result.stdout);
    return !result.error && (result.status === 0 || scope.LoadState === "not-found") ? scope : null;
  }
  function isInNativeScope(life: HandoffNativeLifetime, scope = nativeScope(life)) {
    if (
      !scope ||
      scope.Id !== life.scope ||
      scope.LoadState !== "loaded" ||
      !scope.ControlGroup ||
      (life.placement.kind === "attached" && scope.InvocationID !== life.placement.invocation)
    ) {
      return false;
    }
    // Match the manager's complete path, not a unit-name suffix or the last
    // controller record. Keep the sealed handoff's v1/v2 membership semantics.
    return fs
      .readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .some((line) => {
        const systemd = /^[1-9][0-9]*:name=systemd:(.*)$/.exec(line);
        return line === "0::" + scope.ControlGroup || systemd?.[1] === scope.ControlGroup;
      });
  }
  function nativeClosed(life: HandoffNativeLifetime, scope = nativeScope(life)) {
    // systemd retains populated cgroups even after failed/reset-failed. Its
    // cgroup retirement and unit GC require recursive emptiness, unlike ActiveState.
    return Boolean(
      scope &&
      scope.Id === life.scope &&
      (scope.LoadState === "not-found" ||
        (scope.LoadState === "loaded" &&
          ["inactive", "failed"].some((state) => state === scope.ActiveState) &&
          scope.ControlGroup === "" &&
          (life.placement.kind === "pending" || scope.InvocationID === life.placement.invocation))),
    );
  }
  return { control, properties, nativeScope, isInNativeScope, nativeClosed };
}
