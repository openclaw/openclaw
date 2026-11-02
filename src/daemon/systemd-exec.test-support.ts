import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import type { ExecResult } from "./exec-file.js";

export function nativeExit(stdout = "", stderr = "", code = 0) {
  return { stdout, stderr, code, termination: "exit" as const };
}

export function createSystemdExecFixture(
  run: (
    ...args: Parameters<typeof import("./exec-file.js").execFileUtf8>
  ) => Promise<ExecResult | undefined>,
  version: { useScenarioResponse: boolean },
): typeof import("./exec-file.js").execFileUtf8 {
  return async (command, args, options) => {
    if (args.includes("Version")) {
      expect(command).toBe("busctl");
      expect(args).toEqual([
        ...(args[0] === "--machine"
          ? ["--machine", `${options?.env?.USER}@`, "--user"]
          : ["--user"]),
        "--auto-start=no",
        "get-property",
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "Version",
      ]);
      if (!version.useScenarioResponse) {
        return nativeExit('s "252.39"');
      }
    }
    return expectDefined(await run(command, args, options), "expected native response");
  };
}
