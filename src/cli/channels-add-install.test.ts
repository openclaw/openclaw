import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { ExitError } from "../runtime.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { registerChannelsCli } from "./channels-cli.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function expectInstallFailure(
  install: { npmSpec?: string; clawhubSpec?: string },
  cause: string,
  privateText?: string,
) {
  await withTempHome("openclaw-channels-add-", async (home) => {
    const configPath = path.join(home, "openclaw.json");
    const catalogPath = path.join(home, "catalog.json");
    const config = '{"gateway":{"mode":"local"}}\n';
    await fs.writeFile(configPath, config);
    await fs.writeFile(
      catalogPath,
      JSON.stringify([
        { openclaw: { channel: { id: "fixture-chat", label: "Fixture Chat" }, install } },
      ]),
    );
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_PLUGIN_CATALOG_PATHS", catalogPath);
    vi.stubEnv("CLAWHUB_CONFIG_PATH", path.join(home, "clawhub.json"));
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const argv = [
      "node",
      "openclaw",
      "channels",
      "add",
      "--channel",
      "fixture-chat",
      "--name",
      "Example",
    ];
    const program = new Command().name("openclaw").enablePositionalOptions().exitOverride();
    await registerChannelsCli(program, argv);

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let exitCode: number;
    let stdoutText: string;
    try {
      exitCode = await program.parseAsync(argv).then(
        () => 0,
        (error: unknown) => {
          if (!(error instanceof ExitError)) {
            throw error;
          }
          return error.code;
        },
      );
      stdoutText = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    } finally {
      stdout.mockRestore();
    }
    expect(await fs.readFile(configPath, "utf8")).toBe(config);
    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Could not install the plugin for channel "fixture-chat". '),
    );
    const stderrText = stderr.mock.calls.flat().join("\n");
    expect(stderrText).toContain(cause);
    expect(stderrText).toContain("Install the plugin manually");
    expect(stdoutText).not.toContain(cause);
    if (privateText) {
      for (const output of [stdoutText, stderrText]) {
        expect(output).not.toContain(privateText);
        expect(output).not.toContain("\x1b[31m");
      }
    }
  });
}

it("fails channel addition when the catalog has no usable install source", async () => {
  await expectInstallFailure(
    { npmSpec: "file:./not-a-registry-package" },
    "No usable install source.",
  );
});

it("fails channel addition with the registry cause and leaves config unchanged", async () => {
  const fixtureToken = "synthetic-fixture-token-only-2026";
  let sentAuthorization: string | undefined;
  const registry = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      http.createServer((request, response) => {
        sentAuthorization = request.headers.authorization;
        response
          .writeHead(400)
          .end("\x1b[31mFixture registry denied the package.\x1b[0m " + fixtureToken);
      }),
  });
  try {
    vi.stubEnv("OPENCLAW_CLAWHUB_URL", "http://127.0.0.1:" + registry.claim.port);
    vi.stubEnv("CLAWHUB_TOKEN", fixtureToken);
    vi.stubEnv("CLAWHUB_AUTH_TOKEN", undefined);
    await expectInstallFailure(
      { clawhubSpec: "clawhub:@fixture/fixture-chat" },
      "Fixture registry denied the package.",
      fixtureToken,
    );
    expect(sentAuthorization).toBe("Bearer " + fixtureToken);
  } finally {
    try {
      await registry.releaseListener();
    } finally {
      await registry.claim.release();
    }
  }
});
