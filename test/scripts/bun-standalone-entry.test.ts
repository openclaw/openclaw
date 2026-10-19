import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("preserves the runtime argv prefix through primary and child lazy profile dispatch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-entry-"));
  roots.push(root);
  const sourceUrl = (filename: string) => pathToFileURL(path.resolve(filename)).href;
  const scenarios = ["primary", "module", "worker"].map((kind) => {
    const directory = path.join(root, kind);
    const runtimeRoot = path.join(directory, "runtime");
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const runtimeBootstrap = path.join(directory, "bootstrap.mjs");
    // Model Bun's argv prefix independently of the Node process executing this fixture.
    fs.writeFileSync(
      runtimeBootstrap,
      `process.argv[0] = "bun"; Object.defineProperty(process, "execPath", { value: ${JSON.stringify(path.join(directory, "openclaw"))} });`,
    );
    fs.writeFileSync(
      path.join(runtimeRoot, "openclaw.mjs"),
      `import { Command } from ${JSON.stringify(sourceUrl("node_modules/commander/index.js"))};
import { parseCliProfileArgs } from ${JSON.stringify(sourceUrl("src/cli/profile.ts"))};
import { registerCommandGroups } from ${JSON.stringify(sourceUrl("src/cli/program/register-command-groups.ts"))};
process.title = "openclaw";
const parsed = parseCliProfileArgs(process.argv);
if (!parsed.ok) throw new Error(parsed.error);
process.argv = parsed.argv;
const program = new Command().name("openclaw").enablePositionalOptions().exitOverride();
registerCommandGroups(program, [{
  placeholders: [{ name: "doctor", description: "Fixture Doctor" }],
  register: () => program.command("doctor").option("--non-interactive").action((options) => {
    console.log(JSON.stringify({ kind: ${JSON.stringify(kind)}, profile: parsed.profile, nonInteractive: options.nonInteractive, argv0: process.argv[0] }));
  }),
}], { eager: false, primary: "doctor", registerPrimaryOnly: true });
await program.parseAsync(process.argv);
`,
    );
    const launcher = path.join(directory, "launcher.mjs");
    return {
      launcher,
      url: pathToFileURL(launcher).href,
      options: {
        runtimeBootstrap,
        runtimeRoot,
        moduleEntries: ["openclaw.mjs"],
        workerEntries: kind === "worker" ? ["openclaw.mjs"] : [],
      },
      argv: [
        "bun",
        launcher,
        ...(kind === "primary" ? [] : [path.join(runtimeRoot, "openclaw.mjs")]),
        "--profile",
        "work",
        "doctor",
        "--non-interactive",
      ],
    };
  });
  const driver = path.join(root, "driver.mjs");
  fs.writeFileSync(
    driver,
    `import fs from "node:fs";
import { createStandaloneEntrySource } from ${JSON.stringify(sourceUrl("scripts/lib/bun-standalone-entry.mjs"))};
for (const scenario of ${JSON.stringify(scenarios)}) {
  fs.writeFileSync(scenario.launcher, createStandaloneEntrySource(scenario.options));
  process.argv = scenario.argv;
  await import(scenario.url);
}
`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", createRequire(import.meta.url).resolve("tsx"), driver],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual([
    { kind: "primary", profile: "work", nonInteractive: true, argv0: "bun" },
    { kind: "module", profile: "work", nonInteractive: true, argv0: "bun" },
    { kind: "worker", profile: "work", nonInteractive: true, argv0: "bun" },
  ]);
});
