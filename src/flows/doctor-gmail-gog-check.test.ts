import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { gmailGogCheck } from "./doctor-gmail-gog-check.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
} from "./doctor-health-context.test-support.js";
import { initialDoctorHealthContribution } from "./doctor-health-contributions-selection.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function fixture(options: { inconclusive?: boolean; missing?: boolean } = {}) {
  const root = directories.make("openclaw-doctor-gmail-gog-");
  const bin = path.join(root, "bin");
  const rack = path.join(root, "Cellar", "gogcli");
  const executable = path.join(rack, "0.47.1", "bin", "gog");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(bin);
  const writeExecutable = (file: string, script: string) =>
    fs.writeFileSync(file, `#!${process.execPath}\n${script}`, { mode: 0o755 });
  if (!options.missing) {
    writeExecutable(
      executable,
      `
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.slice(2).join(" ") !== "--json --no-input schema gmail watch serve") process.exit(64);
if (${Boolean(options.inconclusive)}) { console.log("not a schema"); process.exit(0); }
const flags = ["token", "hook-token"];
if (fs.existsSync(path.join(process.env.GOG_FIXTURE_ROOT, "upgraded"))) flags.push("token-env", "hook-token-env");
console.log(JSON.stringify({ schema_version: 1, command: { type: "command", name: "serve", flags: flags.map(name => ({name, type: "string"})) }}));
`,
    );
    fs.symlinkSync(executable, path.join(bin, "gog"));
  }
  writeExecutable(
    path.join(bin, "brew"),
    `
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GOG_FIXTURE_ROOT;
const command = process.argv.slice(2).join(" ");
fs.appendFileSync(path.join(root, "brew-commands"), command + "\\n");
switch (command) {
case "list --formula --full-name": console.log("gogcli"); break;
case "list --formula --pinned": break;
case "--cellar gogcli": console.log(path.join(root, "Cellar", "gogcli")); break;
case "update": break;
case "upgrade gogcli": fs.writeFileSync(path.join(root, "upgraded"), "yes"); break;
default: process.exit(64);
}
`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: bin,
    GOG_FIXTURE_ROOT: root,
    OPENCLAW_UPDATE_IN_PROGRESS: undefined,
  };
  // Homebrew resolves the trusted process PATH, independently of Doctor's env overrides.
  vi.stubEnv("PATH", bin);
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
  const context = createDoctorHealthFlowContext({
    cfg: { hooks: { enabled: true, gmail: { account: "fixture@example.invalid" } } },
    env,
    options: { json: true },
  });
  return {
    root,
    env,
    context,
    upgraded: () => fs.existsSync(path.join(root, "upgraded")),
    brewCommands: () =>
      fs.existsSync(path.join(root, "brew-commands"))
        ? fs.readFileSync(path.join(root, "brew-commands"), "utf8")
        : "",
  };
}

describe.skipIf(process.platform === "win32")("Gmail Gog Doctor contribution", () => {
  it.each([
    [{}, "unsupported", "lacks child-only"],
    [{ inconclusive: true }, "indeterminate", "Could not verify"],
    [{ missing: true }, "indeterminate", "could not be found"],
  ] as const)(
    "reports the configured dependency without upgrading (%j)",
    async (options, support, message) => {
      const test = fixture(options);
      const contribution = initialDoctorHealthContribution("doctor:gmail-gog");
      await contribution.run(test.context);

      expect(test.context.healthFindings).toEqual([
        expect.objectContaining({
          checkId: "core/doctor/gmail-gog",
          severity: "warning",
          message: expect.stringContaining(message),
          details: expect.objectContaining({ support }),
        }),
      ]);
      expect(test.brewCommands()).toBe("");
      expect(test.upgraded()).toBe(false);
    },
  );

  it("ignores Gmail when no enabled watcher is configured", async () => {
    const test = fixture();
    for (const cfg of [
      {},
      { hooks: { enabled: false, gmail: { account: "fixture@example.invalid" } } },
    ]) {
      await expect(
        gmailGogCheck.detect({
          mode: "lint",
          runtime: test.context.runtime,
          cfg,
          env: test.context.env,
        }),
      ).resolves.toEqual([]);
    }
    expect(test.brewCommands()).toBe("");
  });

  it("upgrades only under explicit repair and verifies the selected executable before clearing the finding", async () => {
    const test = fixture();
    test.context.prompter = createDoctorPrompterFixture(true);
    test.context.options.repair = true;
    await initialDoctorHealthContribution("doctor:gmail-gog").run(test.context);

    expect(test.upgraded()).toBe(true);
    expect(test.brewCommands()).toContain("update\n");
    expect(test.brewCommands()).toContain("upgrade gogcli\n");
    expect(test.context.healthFindings).toEqual([]);
    expect(test.context.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Restart the Gmail watcher or Gateway"),
    );
  });

  it.each(["context", "process"] as const)(
    "preserves Gog during the OpenClaw updater's internal repair (%s env)",
    async (source) => {
      const test = fixture();
      test.context.prompter = createDoctorPrompterFixture(true);
      test.context.options = {
        repair: true,
        yes: true,
        nonInteractive: source === "context",
        json: true,
      };
      if (source === "context") {
        test.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
      } else {
        vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
      }
      await initialDoctorHealthContribution("doctor:gmail-gog").run(test.context);

      expect(test.brewCommands()).toBe("");
      expect(test.upgraded()).toBe(false);
      expect(test.context.healthFindings).toHaveLength(1);
      expect(test.context.updateWarnings).toContainEqual(
        expect.stringContaining("Run `openclaw doctor --repair` separately"),
      );
    },
  );
});
