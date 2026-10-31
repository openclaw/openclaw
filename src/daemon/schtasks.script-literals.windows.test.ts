import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { getWindowsCmdExePath } from "../infra/windows-install-roots.js";
import {
  buildTaskScript,
  encodeWindowsLauncherScript,
  readScheduledTaskCommand,
} from "./schtasks-layout.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

it.skipIf(process.platform !== "win32")(
  "preserves task SET literals with either inherited delayed-expansion setting",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-task-literals-"));
    temporary.push(root);
    const cwd = path.join(root, "cwd ^! folder");
    await fs.mkdir(cwd);
    const reporter = path.join(root, "report.cjs");
    const values = [
      "plain",
      "caret^mark",
      "bang!mark",
      "%OPENCLAW_PERCENT_REFERENCE%",
      "%0 %1 %* %~dp0",
      "!OPENCLAW_BANG_REFERENCE!",
      'a"b',
      'a" trailing space ',
      'quoted"&|<>()^outside',
      'a"&echo TASK_ESCAPE_INJECTED>escape-marker.txt&rem "',
      "amp&pipe|less<greater>paren()brackets[]braces{}",
      " leading and trailing \t ",
      "café ü",
      'caret^!percent%quote"&tail',
    ];
    const environment = Object.fromEntries(
      values.map((value, index) => ["OPENCLAW_LITERAL_" + index, value]),
    );
    environment.NODE_OPTIONS = "";
    const argument = "literal^!percent%";
    await fs.writeFile(
      reporter,
      "const names = " +
        JSON.stringify(Object.keys(environment)) +
        "; console.log(JSON.stringify({ values: Object.fromEntries(names.map(name => [name, process.env[name] ?? null])), argv: process.argv.slice(2), cwd: process.cwd() }));",
    );
    const scriptPath = path.join(root, "task with spaces.cmd");
    const programArguments = [process.execPath, reporter, argument];
    const content = buildTaskScript({ programArguments, workingDirectory: cwd, environment });
    await fs.writeFile(scriptPath, encodeWindowsLauncherScript({ format: "cmd", content }));

    for (const expansion of ["off", "on"]) {
      const child = spawnSync(
        getWindowsCmdExePath(),
        ["/d", "/v:" + expansion, "/s", "/c", '""' + scriptPath + '""'],
        {
          cwd: root,
          windowsHide: true,
          windowsVerbatimArguments: true,
          encoding: "utf8",
          timeout: 5000,
          env: {
            SystemRoot: process.env.SystemRoot,
            PATH: path.dirname(getWindowsCmdExePath()),
            TEMP: root,
            TMP: root,
            NODE_OPTIONS: "--task-fixture-invalid-option",
            OPENCLAW_PERCENT_REFERENCE: "expanded-not-literal",
            OPENCLAW_BANG_REFERENCE: "expanded-not-literal",
          },
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      const observed = JSON.parse(child.stdout) as {
        values: Record<string, string | null>;
        argv: string[];
        cwd: string;
      };
      expect(observed.values).toEqual({ ...environment, NODE_OPTIONS: null });
      expect(observed.argv).toEqual([argument]);
      expect(observed.cwd.toLowerCase()).toBe(cwd.toLowerCase());
      await expect(fs.stat(path.join(cwd, "escape-marker.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.stat(path.join(root, "escape-marker.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    for (const requireEffective of [false, true]) {
      const recovered = await readScheduledTaskCommand(
        { OPENCLAW_TASK_SCRIPT: scriptPath },
        { requireEffective },
      );
      expect(recovered?.environment).toEqual(environment);
      expect(recovered?.programArguments).toEqual(programArguments);
      expect(recovered?.workingDirectory).toBe(cwd);
    }
  },
);
