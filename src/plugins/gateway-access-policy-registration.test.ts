import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

it.each(["retirement", "live-grant"])(
  "preserves native registered access-signal ownership through %s",
  async (scenario) => {
    await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        fileURLToPath(
          new URL("./gateway-access-policy-registration.test-support.ts", import.meta.url),
        ),
        scenario,
      ],
      { timeout: 20_000 },
    );
  },
  25_000,
);
