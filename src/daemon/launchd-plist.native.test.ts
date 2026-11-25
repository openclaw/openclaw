import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { findExtraGatewayServices } from "./inspect.js";
import { readLaunchAgentProgramArgumentsFromFile } from "./launchd-plist.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform !== "darwin")("native LaunchAgent definitions", () => {
  it.each(["xml1", "binary1"])(
    "discovers and reads %s definitions with unrelated native data and date values",
    async (format) => {
      const home = dirs.make("native-plist-");
      const directory = path.join(home, "Library", "LaunchAgents");
      const plistPath = path.join(directory, "synthetic.plist");
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        plistPath,
        `<plist><dict>
<key>EnvironmentVariables</key><dict>
<key>Label</key><string>nested-label</string>
<key>LITERAL</key><string>&lt;data&gt;literal&lt;/data&gt;</string>
</dict>
<key>Label</key><string>org.synthetic.a&amp;b</string>
<key>ProgramArguments</key><array><string>/usr/bin/openclaw</string><string>gateway</string></array>
<key>Payload</key><data>c3ludGhldGlj</data>
<key>Created</key><date>2026-09-17T00:00:00Z</date>
</dict></plist>`,
      );
      execFileSync("/usr/bin/plutil", ["-convert", format, "--", plistPath]);

      expect(await findExtraGatewayServices({ HOME: home })).toEqual({
        services: [expect.objectContaining({ label: "org.synthetic.a&b", marker: "openclaw" })],
        errors: [],
      });
      await expect(
        readLaunchAgentProgramArgumentsFromFile(plistPath, { requireEffective: true }),
      ).resolves.toMatchObject({
        programArguments: ["/usr/bin/openclaw", "gateway"],
        environment: { Label: "nested-label", LITERAL: "<data>literal</data>" },
      });
    },
  );

  it.each(["data", "date"])("rejects %s values in command fields", async (scalar) => {
    const home = dirs.make("native-plist-invalid-");
    const plistPath = path.join(home, "gateway.plist");
    const value = scalar === "data" ? "c3ludGhldGlj" : "2026-09-17T00:00:00Z";
    for (const field of ["ProgramArguments", "WorkingDirectory", "EnvironmentVariables"]) {
      const fields = new Map([
        ["ProgramArguments", "<array><string>openclaw</string><string>gateway</string></array>"],
        [field, `<${scalar}>${value}</${scalar}>`],
      ]);
      await fs.writeFile(
        plistPath,
        `<plist><dict>${Array.from(fields, ([key, element]) => `<key>${key}</key>${element}`).join("")}</dict></plist>`,
      );
      await expect(
        readLaunchAgentProgramArgumentsFromFile(plistPath, { requireEffective: true }),
      ).rejects.toThrow("Effective LaunchAgent service command could not be inspected");
    }
  });
});
