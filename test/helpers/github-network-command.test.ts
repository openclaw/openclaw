import { execFile, execFileSync, execSync, spawnSync } from "node:child_process";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { withGitHubNegativeControl as negativeControl } from "./github-network-guard.mjs";
import { requireNodeTool } from "./node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const forbidden = "GitHub network access is forbidden in ordinary tests";

it.skipIf(process.platform === "win32")(
  "allows native loopback curl and refuses redirects before dispatch",
  async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/final" });
      }
      response.end("synthetic response");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("server did not bind TCP");
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const result = await promisify(execFile)("curl", ["--silent", `${origin}/final`]);
      expect(result.stdout).toBe("synthetic response");
      expect(requests).toBe(1);
      await expect(
        negativeControl(async () => promisify(execFile)("curl", ["-L", `${origin}/redirect`])),
      ).rejects.toThrow(forbidden);
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);

it
  .skipIf(process.platform === "win32")
  .each([
    "shell file",
    "shell command",
    "env delegation",
    "PATH script",
    "after cd",
    "assignment",
    "assigned variable",
    "rcfile",
    "init-file",
  ])("blocks absolute native HTTP through %s", (entry) => {
  const directory = tempDirs.make("github-native-wrapper-");
  const curl = join(directory, "curl");
  // Even without admission this alias cannot open a socket.
  symlinkSync("/usr/bin/true", curl);
  const script = join(directory, "probe.sh");
  const transport = entry === "assigned variable" ? '"$FIXTURE/curl"' : `'${curl}'`;
  writeFileSync(script, `#!/bin/sh\n${transport} https://api.github.com/negative-control\n`, {
    mode: 0o755,
  });
  expect(() =>
    negativeControl(() =>
      entry === "shell file"
        ? execFileSync("/bin/sh", [script])
        : entry === "shell command"
          ? execSync(`/bin/sh '${script}'`)
          : entry === "PATH script"
            ? execSync("probe.sh", { env: { PATH: `${directory}:/usr/bin:/bin` } })
            : entry === "after cd"
              ? execSync(`cd '${directory}'; /bin/sh ./probe.sh`)
              : entry === "rcfile" || entry === "init-file"
                ? execFileSync("/bin/bash", [`--${entry}`, script, "-ic", "true"], {
                    stdio: "ignore",
                  })
                : entry === "assignment" || entry === "assigned variable"
                  ? execSync(`FIXTURE='${directory}' NOTE='two words' /bin/sh '${script}'`)
                  : execFileSync("/usr/bin/env", [
                      "-i",
                      curl,
                      "https://api.github.com/negative-control",
                    ]),
    ),
  ).toThrow(forbidden);
});

it.skipIf(process.platform === "win32").each([
  ["command", "PATH"],
  ["file", "PATH"],
  ["command", "NODE_OPTIONS"],
  ["unset", "NODE_OPTIONS"],
  ["unset", "PATH"],
  ["command", "BASH_ENV"],
])("refuses shell guard environment replacement in a %s: %s", (entry, variable) => {
  const directory = tempDirs.make("github-shell-path-");
  symlinkSync("/usr/bin/true", join(directory, "curl"));
  symlinkSync("/usr/bin/true", join(directory, "node"));
  const source =
    entry === "unset"
      ? `unset UNUSED ${variable}; '${directory}/node' --version`
      : variable === "PATH"
        ? `PATH='${directory}' curl https://api.github.com/negative-control`
        : `${variable}='' node --version`;
  const script = join(directory, "probe.sh");
  writeFileSync(script, `${source}\n`);
  expect(() =>
    negativeControl(() =>
      entry !== "file"
        ? execSync(source, { env: { PATH: directory } })
        : execFileSync("/bin/sh", [script]),
    ),
  ).toThrow(forbidden);
});

it.skipIf(process.platform === "win32").each(["dash", "ksh", "pwsh"])(
  "inspects native %s shell input before dispatch",
  (shell) => {
    const directory = tempDirs.make("github-shell-input-");
    const executable = join(directory, shell);
    symlinkSync("/usr/bin/true", executable);
    const script = join(directory, "probe.ps1");
    writeFileSync(script, "Invoke-WebRequest https://api.github.com/negative-control\n");
    const args =
      shell === "pwsh"
        ? ["-NoProfile", "-File", script]
        : ["-c", "/usr/bin/curl https://api.github.com/negative-control"];
    expect(() => negativeControl(() => execFileSync(executable, args))).toThrow(forbidden);
  },
);

it.skipIf(process.platform === "win32").each(["--login", "-lc", "-ic"])(
  "refuses shell startup mode %s before dispatch",
  (mode) => {
    const directory = tempDirs.make("github-shell-startup-mode-");
    const executable = join(directory, "bash");
    // A native no-op keeps the pre-fix probe independent of host startup files.
    symlinkSync("/usr/bin/true", executable);
    const args = mode === "--login" ? [mode, "-c", "true"] : [mode, "true"];
    expect(() => negativeControl(() => execFileSync(executable, args))).toThrow(forbidden);
  },
);

it
  .skipIf(process.platform === "win32")
  .each([
    "argv0",
    "exec argv0",
    "exec login",
    "exec delimiter",
    "command delimiter",
    "shebang",
    "env shebang",
    "PowerShell command",
    "PowerShell file",
    "PowerShell shell option",
    "cmd AutoRun",
  ])("refuses uninspected shell startup through %s", (entry) => {
  const directory = tempDirs.make("github-shell-startup-entry-");
  const shell = join(
    directory,
    entry.startsWith("PowerShell") ? "pwsh" : entry === "cmd AutoRun" ? "cmd" : "bash",
  );
  symlinkSync("/usr/bin/true", shell);
  const script = join(directory, "probe");
  writeFileSync(
    script,
    entry === "env shebang" ? `#!/usr/bin/env -S ${shell} -l\ntrue\n` : `#!${shell} -l\ntrue\n`,
  );
  chmodSync(script, 0o755);
  expect(() =>
    negativeControl(() => {
      if (entry === "argv0") {
        return spawnSync(shell, ["-c", "true"], { argv0: "-bash" });
      }
      if (entry.startsWith("exec ") || entry === "command delimiter") {
        const prefix =
          entry === "exec argv0"
            ? "exec -a -bash"
            : entry === "exec login"
              ? "exec -l"
              : entry === "exec delimiter"
                ? "exec --"
                : "command --";
        return execFileSync("/bin/bash", ["-c", `${prefix} '${shell}' -c true`]);
      }
      if (entry === "PowerShell command") {
        return execFileSync(shell, ["-Command", "Write-Output ok"]);
      }
      if (entry === "PowerShell file") {
        return execFileSync(shell, ["-File", script]);
      }
      if (entry === "PowerShell shell option") {
        return execSync("Write-Output ok", { shell });
      }
      if (entry === "cmd AutoRun") {
        return execFileSync(shell, ["/c", "echo ok"]);
      }
      return execFileSync(script);
    }),
  ).toThrow(forbidden);
  if (entry === "PowerShell command") {
    expect(
      execFileSync(shell, ["-NoProfile", "-Command", "Write-Output ok"], { encoding: "utf8" }),
    ).toBe("");
  } else if (entry === "cmd AutoRun") {
    expect(execFileSync(shell, ["/d", "/c", "echo ok"], { encoding: "utf8" })).toBe("");
  }
});

it.skipIf(process.platform === "win32")(
  "retains the Node preload through nested clean env wrappers",
  () => {
    const node = requireNodeTool("node");
    const result = negativeControl(() =>
      spawnSync(
        "/usr/bin/env",
        [
          "-i",
          "/usr/bin/env",
          "-i",
          node,
          "--input-type=module",
          "-e",
          'import dns from "node:dns"; dns.lookup = () => { throw new Error("unexpected DNS dispatch"); }; await fetch("https://api.github.com/");',
        ],
        { encoding: "utf8" },
      ),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(forbidden);
  },
);

it.skipIf(process.platform === "win32").each(["cmd", "bat", "start", "call", "Start-Process"])(
  "refuses uninspected Windows shell delegation through %s",
  (entry) => {
    const directory = tempDirs.make("github-windows-delegation-");
    const shell = join(directory, entry === "Start-Process" ? "pwsh" : "cmd");
    symlinkSync("/usr/bin/true", shell);
    const curl = join(directory, "curl");
    symlinkSync("/usr/bin/true", curl);
    const script = join(directory, `probe.${entry}`);
    writeFileSync(script, `"${curl}" https://api.github.com/negative-control\n`);
    const args =
      entry === "Start-Process"
        ? [
            "-NoProfile",
            "-Command",
            "Start-Process pwsh -ArgumentList '-Command', 'Write-Output ok'",
          ]
        : [
            "/d",
            "/c",
            ["cmd", "bat"].includes(entry) ? `"${script}"` : `${entry} cmd.exe /c echo ok`,
          ];
    expect(() => negativeControl(() => execFileSync(shell, args))).toThrow(forbidden);
  },
);

it
  .skipIf(process.platform === "win32")
  .each([
    ["--url", "@urls.txt"],
    ["--url", "@-"],
    ["--url=@urls.txt"],
    ["--header", "@headers.txt", "http://127.0.0.1/"],
    ["https://fixture.example.test\\@github.com/"],
  ])("refuses ambiguous native HTTP destinations: %j", (...args) => {
  const directory = tempDirs.make("github-curl-indirection-");
  const curl = join(directory, "curl");
  // The negative control remains harmless without admission or with an older curl.
  symlinkSync("/usr/bin/true", curl);
  expect(() => negativeControl(() => execFileSync(curl, args))).toThrow(forbidden);
});
