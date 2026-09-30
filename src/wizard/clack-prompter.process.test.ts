import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { clackPrompterProcessEntrypoint } from "./clack-prompter-process-runtime.test-support.js";

const homes = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...homes].map(async (home) => {
      homes.delete(home);
      await fs.rm(home, { recursive: true, force: true });
    }),
  );
});

describe("classic onboarding process", () => {
  it("exits through wizard cancellation when Ctrl-D ends stdin at the first prompt", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-onboard-eof-"));
    homes.add(home);
    // oxlint-disable-next-line no-warning-comments -- remove after the upstream Bun fix ships.
    // TODO(bun): Run node-pty from Bun after https://github.com/oven-sh/bun/issues/25822.
    const result = await runNodeScript(
      [
        fileURLToPath(new URL("./clack-prompter.process-driver.mjs", import.meta.url)),
        process.execPath,
        home,
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(clackPrompterProcessEntrypoint),
          process.execPath,
        ),
      ],
      process.env,
      65_000,
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      exit: { exitCode: number; signal?: number };
      output: string;
      sentEof: boolean;
    };
    expect(parsed.exit).toMatchObject({ exitCode: 1 });
    expect(parsed.sentEof, stripAnsi(parsed.output)).toBe(true);
    expect(stripAnsi(parsed.output)).not.toContain("unsettled top-level await");
  }, 70_000);
});
