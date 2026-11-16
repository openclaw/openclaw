import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs } from "../../test/helpers/temp-dir.js";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { measureCliCommandStartup } from "./command-startup-timing.js";

const tempDirs: string[] = [];

afterEach(() => {
  flushDiagnosticsTimeline();
  cleanupTempDirs(tempDirs);
});

describe("measureCliCommandStartup", () => {
  it("runs directly when no timeline path is configured", async () => {
    await expect(
      measureCliCommandStartup("config-ready", async () => "ready", {
        env: {
          OPENCLAW_DIAGNOSTICS: "timeline",
        },
      }),
    ).resolves.toBe("ready");
  });

  it("records the command startup stage without changing the result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-cli-command-startup-"));
    tempDirs.push(dir);
    const path = join(dir, "timeline.jsonl");
    const env = {
      OPENCLAW_DIAGNOSTICS: "timeline",
      OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: path,
    } as NodeJS.ProcessEnv;

    await expect(
      measureCliCommandStartup("config-ready", async () => "ready", { env }),
    ).resolves.toBe("ready");

    flushDiagnosticsTimeline();
    const events = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "span.start",
      name: "cli.command-startup",
      phase: "cli.command-startup",
      attributes: { stage: "config-ready" },
    });
    expect(events[1]).toMatchObject({
      type: "span.end",
      name: "cli.command-startup",
      phase: "cli.command-startup",
      attributes: { stage: "config-ready" },
    });
  });
});
