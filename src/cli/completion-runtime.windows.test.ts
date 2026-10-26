import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  installCompletion,
  isCompletionInstalled,
  resolveCompletionCachePath,
  resolveCompletionProfilePath,
  usesSlowDynamicCompletion,
} from "./completion-runtime.js";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runPowerShell = (command: string, env: NodeJS.ProcessEnv) =>
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
it.skipIf(process.platform !== "win32").each([
  ["Unicode", "utf-16le", "fffe"],
  ["BigEndianUnicode", "utf-16be", "feff"],
  ["utf8", "utf-8", "efbbbf"],
  [null, "utf-8", ""],
] as const)(
  "preserves and reloads a %s profile during cached completion installation",
  async (encoding, decoder, bom) => {
    const homeDir = tempDirs.make("openclaw-powershell-profile-");
    const env = {
      HOME: homeDir,
      USERPROFILE: homeDir,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: path.join(homeDir, "state"),
      SHELL: "powershell.exe",
    };
    await withEnvAsync(env, async () => {
      const profilePath = resolveCompletionProfilePath("powershell");
      const cachePath = resolveCompletionCachePath("powershell", "openclaw");
      const greeting = bom ? "café €" : "plain ASCII control";
      const userLine = `$global:ProfileGreeting = '${greeting}'`;
      const dynamicLine = "openclaw completion --shell powershell | Out-String | Invoke-Expression";
      for (const file of [profilePath, cachePath]) {
        await fs.mkdir(path.dirname(file), { recursive: true });
      }
      await fs.writeFile(cachePath, "$global:CompletionCacheLoaded = $true\r\n", "utf8");
      const fixtureCommand = encoding
        ? `$env:PROFILE_FIXTURE_TEXT | Out-File -LiteralPath $env:PROFILE_FIXTURE_PATH -NoNewline -Encoding ${encoding}`
        : "[IO.File]::WriteAllText($env:PROFILE_FIXTURE_PATH, $env:PROFILE_FIXTURE_TEXT, [Text.UTF8Encoding]::new($false))";
      const fixture = runPowerShell(`$ErrorActionPreference = 'Stop'; ${fixtureCommand}`, {
        PROFILE_FIXTURE_PATH: profilePath,
        PROFILE_FIXTURE_TEXT: `${dynamicLine}\r\n${userLine}\r\n`,
      });
      expect(fixture.error).toBeUndefined();
      expect(fixture.status, fixture.stderr).toBe(0);
      expect(await usesSlowDynamicCompletion("powershell", "openclaw")).toBe(true);
      await installCompletion("powershell", true, "openclaw");
      const bytes = await fs.readFile(profilePath);
      const content = new TextDecoder(decoder).decode(bytes);
      const prefix = bytes.subarray(0, 3).toString("hex");
      expect(prefix.match(/^(fffe|feff|efbbbf)/)?.[0] ?? "").toBe(bom);
      expect(content).toContain(userLine);
      expect(content).not.toContain(dynamicLine);
      const loaded = runPowerShell(
        `
        $ErrorActionPreference = 'Stop'
        . $env:PROFILE_FIXTURE_PATH
        @{
          greeting = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($global:ProfileGreeting))
          completionLoaded = $global:CompletionCacheLoaded -eq $true
          powershellMajor = $PSVersionTable.PSVersion.Major
        } | ConvertTo-Json -Compress
      `,
        { PROFILE_FIXTURE_PATH: profilePath },
      );
      expect(loaded.status, loaded.stderr).toBe(0);
      expect(JSON.parse(loaded.stdout.trim())).toEqual({
        greeting: Buffer.from(greeting, "utf8").toString("base64"),
        completionLoaded: true,
        powershellMajor: 5,
      });
      await installCompletion("powershell", true, "openclaw");
      expect(await isCompletionInstalled("powershell", "openclaw")).toBe(true);
      expect(await fs.readFile(profilePath)).toEqual(bytes);
    });
  },
  60_000,
);
