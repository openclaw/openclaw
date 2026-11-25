import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runPluginsValidateCommand } from "./plugins-authoring-command.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function expectFailure(
  opts: Parameters<typeof runPluginsValidateCommand>[0],
  env: NodeJS.ProcessEnv,
  message: string,
  jsonMessage = message,
) {
  const originalArgv = process.argv;
  const exitError = new Error("expected validation exit");
  using writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  using log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  using error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  using exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
    throw exitError;
  });
  try {
    process.argv = ["node", "openclaw", "plugins", "validate", "--json"];
    await expect(
      withEnvAsync(env, () => runPluginsValidateCommand({ ...opts, json: true })),
    ).rejects.toBe(exitError);
    expect(writeJson).toHaveBeenCalledExactlyOnceWith({ valid: false, errors: [jsonMessage] });
    expect(error).toHaveBeenCalledExactlyOnceWith(message);
    expect(log).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1, { resetStream: process.stderr });
  } finally {
    process.argv = originalArgv;
  }
}

it.each(
  ["implicit", "explicit"].flatMap((entry) => [false, true].map((debug) => ({ entry, debug }))),
)(
  "preserves native JSON parse detail only for debug=$debug ($entry entry)",
  async ({ debug, entry }) => {
    const homeDir = tempDirs.make("openclaw-plugin-parse-debug-home-");
    const rootDir = path.join(homeDir, "plugins", "malformed");
    fs.mkdirSync(rootDir, { recursive: true });
    const packagePath = path.join(rootDir, "package.json");
    const packageBytes = '{\n  "name": "validation-fixture",\n  "version":\n}\n';
    fs.writeFileSync(packagePath, packageBytes);
    let parserError: unknown;
    try {
      JSON.parse(packageBytes);
    } catch (error) {
      parserError = error;
    }
    if (!(parserError instanceof SyntaxError)) {
      throw new Error("Malformed package fixture did not produce a native parser error");
    }
    const detail = debug ? ` | ${parserError.message}` : "";
    const terminalDetail = detail.replaceAll("\n", "\\n");
    await expectFailure(
      { root: rootDir, ...(entry === "explicit" ? { entry: "./unused-entry.js" } : {}) },
      { OPENCLAW_HOME: homeDir, OPENCLAW_DEBUG: debug ? "1" : undefined },
      `Malformed JSON in ${packagePath}${terminalDetail}`,
      `Malformed JSON in $OPENCLAW_HOME/plugins/malformed/package.json${detail}`,
    );
    expect(fs.readFileSync(packagePath, "utf8")).toBe(packageBytes);
    expect(fs.readdirSync(rootDir)).toEqual(["package.json"]);
  },
);

it.each(
  [
    {
      label: "custom toString",
      expression:
        '{ toString() { return "custom validation failure"; }, detail: "do-not-print-fields" }',
      expected: "custom validation failure",
    },
    {
      label: "status/code record",
      expression: '{ status: 503, code: "UNAVAILABLE" }',
      expected: "[object Object]",
    },
  ].flatMap((entry) => [false, true].map((debug) => Object.assign({}, entry, { debug }))),
)(
  "preserves String for a thrown $label with debug=$debug",
  async ({ expression, expected, debug }) => {
    const rootDir = tempDirs.make("openclaw-plugin-non-error-");
    const files = {
      "package.json": JSON.stringify({
        name: "validation-non-error",
        type: "commonjs",
        openclaw: { extensions: ["./entry.cjs"] },
      }),
      "openclaw.plugin.json": JSON.stringify({ id: "validation-non-error", configSchema: {} }),
      "entry.cjs": `module.exports = function () { throw ${expression}; };\n`,
    };
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(rootDir, name), contents);
    }
    await expectFailure({ root: rootDir }, { OPENCLAW_DEBUG: debug ? "1" : undefined }, expected);
    for (const [name, contents] of Object.entries(files)) {
      expect(fs.readFileSync(path.join(rootDir, name), "utf8")).toBe(contents);
    }
    expect(fs.readdirSync(rootDir).toSorted()).toEqual(Object.keys(files).toSorted());
  },
);
