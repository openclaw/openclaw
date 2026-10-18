import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
it.runIf(process.platform === "darwin").each([false, true])(
  "inspects real process topology, identities, and arguments on main and Worker (Seatbelt=%s)",
  async (seatbelt) => {
    const fixture = fileURLToPath(
      new URL("./darwin-process-inspection.test-support.mjs", import.meta.url),
    );
    const command = seatbelt ? "/usr/bin/sandbox-exec" : process.execPath;
    // Seatbelt refuses Apple's setuid ps even with default access allowed.
    const args = seatbelt
      ? ["-p", "(version 1)(allow default)", process.execPath, fixture, "--seatbelt"]
      : [fixture];
    const { stdout } = await exec(command, args);
    expect(JSON.parse(stdout)).toEqual({
      threads: 2,
      child: "observed",
      startedAtCompatible: true,
      psBlocked: seatbelt,
    });
  },
);
