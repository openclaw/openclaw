import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runPluginsValidateCommand } from "./plugins-authoring-command.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("plugin validation output", () => {
  it.each([
    { debug: false, entry: "implicit" },
    { debug: true, entry: "implicit" },
    { debug: false, entry: "explicit" },
    { debug: true, entry: "explicit" },
  ])(
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
      expect(parserError).toBeInstanceOf(SyntaxError);
      if (!(parserError instanceof Error)) {
        throw new Error("Malformed package fixture did not produce a native parser error");
      }
      const detail = debug ? ` | ${parserError.message}` : "";
      const originalArgv = process.argv;
      const exitError = new Error("expected validation exit");
      const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
        throw exitError;
      });

      try {
        process.argv = ["node", "openclaw", "plugins", "validate", "--json"];
        await expect(
          withEnvAsync(
            { OPENCLAW_HOME: homeDir, OPENCLAW_DEBUG: debug ? "1" : undefined },
            async () => {
              await runPluginsValidateCommand({
                root: rootDir,
                json: true,
                ...(entry === "explicit" ? { entry: "./unused-entry.js" } : {}),
              });
            },
          ),
        ).rejects.toBe(exitError);
        expect(writeJson).toHaveBeenCalledExactlyOnceWith({
          valid: false,
          errors: [`Malformed JSON in $OPENCLAW_HOME/plugins/malformed/package.json${detail}`],
        });
        expect(error).toHaveBeenCalledExactlyOnceWith(`Malformed JSON in ${packagePath}${detail}`);
        expect(log).not.toHaveBeenCalled();
        expect(exit).toHaveBeenCalledExactlyOnceWith(1, { resetStream: process.stderr });
        expect(fs.readFileSync(packagePath, "utf8")).toBe(packageBytes);
        expect(fs.readdirSync(rootDir)).toEqual(["package.json"]);
      } finally {
        process.argv = originalArgv;
        writeJson.mockRestore();
        log.mockRestore();
        error.mockRestore();
        exit.mockRestore();
      }
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
    ].flatMap((entry) => [
      { ...entry, debug: false },
      { ...entry, debug: true },
    ]),
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
      const originalArgv = process.argv;
      const exitError = new Error("expected non-error validation exit");
      const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
        throw exitError;
      });
      try {
        process.argv = ["node", "openclaw", "plugins", "validate", "--json"];
        await expect(
          withEnvAsync({ OPENCLAW_DEBUG: debug ? "1" : undefined }, async () => {
            await runPluginsValidateCommand({ root: rootDir, json: true });
          }),
        ).rejects.toBe(exitError);
        expect(writeJson).toHaveBeenCalledExactlyOnceWith({ valid: false, errors: [expected] });
        expect(error).toHaveBeenCalledExactlyOnceWith(expected);
        expect(log).not.toHaveBeenCalled();
        expect(exit).toHaveBeenCalledExactlyOnceWith(1, { resetStream: process.stderr });
        for (const [name, contents] of Object.entries(files)) {
          expect(fs.readFileSync(path.join(rootDir, name), "utf8")).toBe(contents);
        }
        expect(fs.readdirSync(rootDir).toSorted()).toEqual(Object.keys(files).toSorted());
      } finally {
        process.argv = originalArgv;
        writeJson.mockRestore();
        log.mockRestore();
        error.mockRestore();
        exit.mockRestore();
      }
    },
  );
});
