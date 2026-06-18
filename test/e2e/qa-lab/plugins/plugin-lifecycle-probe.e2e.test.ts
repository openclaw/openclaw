// Plugin Lifecycle Probe tests cover QA Lab plugin lifecycle evidence.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  assertInspectLoaded,
  assertUninstalled,
  parseDurationMs,
} from "./plugin-lifecycle-probe-runtime.js";

const tempDirs = createTempDirTracker();

function makeTempDir(): string {
  return tempDirs.make("openclaw-plugin-lifecycle-probe-");
}

afterEach(tempDirs.cleanup);

describe("plugin lifecycle matrix probe", () => {
  it("accepts inspect JSON for an enabled loaded plugin", async () => {
    const dir = makeTempDir();
    const inspectPath = path.join(dir, "inspect.json");
    writeFileSync(
      inspectPath,
      `${JSON.stringify({ plugin: { enabled: true, id: "lifecycle-claw", status: "loaded" } })}\n`,
      "utf8",
    );

    expect(() => assertInspectLoaded("lifecycle-claw", inspectPath)).not.toThrow();
  });

  it("rejects inspect JSON that does not prove the runtime loaded", async () => {
    const dir = makeTempDir();
    const inspectPath = path.join(dir, "inspect.json");
    writeFileSync(
      inspectPath,
      `${JSON.stringify({ plugin: { enabled: true, id: "lifecycle-claw", status: "pending" } })}\n`,
      "utf8",
    );

    expect(() => assertInspectLoaded("lifecycle-claw", inspectPath)).toThrow(
      "expected lifecycle-claw inspect status loaded, got pending",
    );
  });

  it("rejects missing inspect JSON instead of treating it as an empty object", async () => {
    const dir = makeTempDir();
    const inspectPath = path.join(dir, "missing.json");

    expect(() => assertInspectLoaded("lifecycle-claw", inspectPath)).toThrow(
      `failed to read JSON from ${inspectPath}`,
    );
  });

  it("rejects unreadable config during uninstall proof", async () => {
    const dir = makeTempDir();
    const configFile = path.join(dir, ".openclaw", "openclaw.json");
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, "{ malformed\n", "utf8");

    expect(() =>
      assertUninstalled("lifecycle-claw", {
        HOME: dir,
        OPENCLAW_CONFIG_PATH: configFile,
      }),
    ).toThrow(`failed to read JSON from ${configFile}`);
  });

  it("preserves disabled npm install timeout semantics", () => {
    expect(parseDurationMs("0", "600s")).toBeUndefined();
  });
});
