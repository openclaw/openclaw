import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as exec from "../process/exec.js";
import { installLaunchAgent, stageLaunchAgent } from "./launchd-install.js";
import { readLaunchAgentProgramArgumentsFromFile as readCommand } from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import { readLaunchAgentProgramArguments } from "./launchd-runtime.js";
import * as serviceFiles from "./launchd-service-files.js";

const native = vi.hoisted(() => ({
  ownership: vi.fn<typeof import("./launchd-system.js").assertNoSystemLaunchDaemonOwnership>(),
  launchctl: vi.fn<typeof import("./launchd-exec.js").execLaunchctl>(),
}));
vi.mock("./launchd-system.js", async (original) => ({
  ...(await original<typeof import("./launchd-system.js")>()),
  assertNoSystemLaunchDaemonOwnership: native.ownership,
}));
vi.mock("./launchd-exec.js", async (original) => ({
  ...(await original<typeof import("./launchd-exec.js")>()),
  execLaunchctl: native.launchctl,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
function fixture(name: string, environment: Record<string, string>, stateDir = false) {
  const home = dirs.make(`launchd-${name}-`);
  const label = `ai.openclaw.${name}-test`;
  const env = {
    HOME: home,
    OPENCLAW_STATE_DIR: stateDir ? path.join(home, "state") : home,
    OPENCLAW_LAUNCHD_LABEL: label,
  };
  return {
    home,
    label,
    env,
    args: { env, stdout: new PassThrough(), programArguments, environment: { ...environment } },
    plistPath: serviceFiles.resolveLaunchAgentPlistPath(env),
    wrapper: serviceFiles.resolveLaunchAgentEnvWrapperPath(env, label),
    envFile: serviceFiles.resolveLaunchAgentEnvFilePath(env, label),
  };
}
const programArguments = ["/usr/bin/node", "/opt/openclaw/openclaw.mjs", "gateway"];
async function writeFile(file: string, contents: string | Buffer, mode: number) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
  await fs.chmod(file, mode);
}
async function readSnapshot(file: Parameters<typeof fs.stat>[0]) {
  return { contents: await fs.readFile(file), mode: (await fs.stat(file)).mode & 0o7777 };
}
beforeEach(() => {
  native.ownership.mockReset().mockResolvedValue(undefined);
  native.launchctl.mockReset().mockImplementation(async (args) => {
    const responses = new Map([
      ["print", { stderr: "Could not find service", code: 113 }],
      ["enable", { stderr: "", code: 0 }],
      ["bootstrap", { stderr: "synthetic activation refusal", code: 1 }],
    ]);
    const result = responses.get(args[0] ?? "");
    if (!result) {
      throw new Error(`Unexpected launchctl command: ${args[0]}`);
    }
    return { stdout: "", ...result, termination: "exit" };
  });
  vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", undefined);
});
afterEach(() => vi.restoreAllMocks());

// Binary plist containing only a synthetic label, command, and inline environment value.
const binaryPlist = Buffer.from(
  "YnBsaXN0MDDVAQIDBAUGBwkMDFVMYWJlbF8QEFByb2dyYW1Bcmd1bWVudHNfEBRFbnZpcm9ubWVudFZhcmlhYmxlc1lSdW5BdExvYWRZS2VlcEFsaXZlXxAZYWkub3BlbmNsYXcucm9sbGJhY2stdGVzdKEIXS91c3IvYmluL3RydWXRCgtfEBBTWU5USEVUSUNfSU5MSU5FXxAVcHJpdmF0ZSBmaXh0dXJlIHZhbHVlCQgTGSxDTVdzdYOGmbEAAAAAAAABAQAAAAAAAAANAAAAAAAAAAAAAAAAAAAAsg==",
  "base64",
);

describe.skipIf(process.platform === "win32")("LaunchAgent file restoration", () => {
  it.each([
    ["three-line PEM", "-----BEGIN PRIVATE KEY-----  \nfixture\n-----END PRIVATE KEY-----"],
    ["escaped quotes and trailing newline", "first 'quoted'\nsecond 'line'\n"],
  ])("preserves %s through service readCommand and restart regeneration", async (_name, value) => {
    vi.spyOn(exec, "runExec").mockImplementation(async (file, args, options) => {
      if (file !== "/usr/bin/plutil" || typeof options !== "object" || !options.input) {
        throw new Error(`Unexpected native command: ${file}`);
      }
      return decodeLaunchAgentPlistFixture(options.input, args[1]);
    });
    const environment = { FIXTURE: value, NEXT: "retained" };
    const { env, label, plistPath, wrapper, envFile, args } = fixture("reinstall", environment);
    const expected = { programArguments, environment };
    await stageLaunchAgent(args);
    await expect(readLaunchAgentProgramArguments(env)).resolves.toMatchObject(expected);
    await serviceFiles.rewriteLaunchAgentPlistForRestart({ env, label, plistPath });
    const plist = await fs.readFile(plistPath, "utf8");
    const array =
      plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "";
    const rawArguments = [...array.matchAll(/<string>(.*?)<\/string>/g)].map((match) => match[1]);
    expect(rawArguments).toEqual(["/bin/sh", wrapper, envFile, ...programArguments]);
    await expect(
      readCommand(plistPath, {
        ...serviceFiles.resolveLaunchAgentEnvironmentReadOptions(env, label),
        requireEffective: true,
      }),
    ).resolves.toMatchObject(expected);
  });

  it("executes the installed env wrapper only with its generated readable environment", async () => {
    const value = "literal ' value\nsecond line";
    const { home, wrapper, envFile, args } = fixture("wrapper", { FIXTURE: value });
    await stageLaunchAgent(args);
    const run = (input: string, command: string) =>
      spawnSync("/bin/sh", [wrapper, input, "/bin/sh", "-c", command], { encoding: "utf8" });
    expect(run(envFile, 'printf "%s" "$FIXTURE"')).toMatchObject({ status: 0, stdout: value });

    const nonEnv = path.join(home, "not-generated.env");
    await fs.writeFile(nonEnv, "printf sourced-unexpected-input\n");
    for (const input of [process.execPath, nonEnv, home, path.join(home, "missing.env")]) {
      const invalid = run(input, "printf started");
      expect(invalid).toMatchObject({ status: 78, stdout: "" });
      expect(invalid.stderr).toContain("Invalid LaunchAgent environment file");
      expect(invalid.stderr).toContain("openclaw gateway install --force");
    }
  });

  it("binds rollback bytes and permissions to one file and closes its descriptor", async () => {
    const { home, plistPath } = fixture("snapshot", {});
    const replacementPath = path.join(home, "replacement.plist");
    const original = { contents: binaryPlist, mode: 0o600 };
    await writeFile(plistPath, original.contents, original.mode);
    await writeFile(replacementPath, "replacement", 0o644);
    const { readFile, open } = fs;
    let replaced = false;
    const replacePath = async <T>(target: Parameters<typeof fs.readFile>[0], result: T) => {
      if (target === plistPath && !replaced) {
        replaced = true;
        await fs.rename(replacementPath, plistPath);
      }
      return result;
    };
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) =>
      replacePath(args[0], await readFile(...args)),
    );
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(async (...args) => replacePath(args[0], await open(...args)));
    expect(await serviceFiles.readExistingLaunchAgentPlist(plistPath)).toEqual(original);
    const captureIndex = openSpy.mock.calls.findIndex(([file]) => file === plistPath);
    const captured = openSpy.mock.results[captureIndex];
    if (captured?.type !== "return") {
      throw new Error("Snapshot descriptor was not captured");
    }
    await expect((await captured.value).stat()).rejects.toMatchObject({ code: "EBADF" });
    expect(await readFile(plistPath, "utf8")).toBe("replacement");
    expect((await fs.stat(plistPath)).mode & 0o7777).toBe(0o644);
  });

  it.each([
    { mode: 0o640, failure: "publication ownership" },
    { mode: 0o1600, failure: "install activation" },
  ])("restores bytes and mode $mode after $failure failure", async ({ mode, failure }) => {
    const { plistPath, envFile, wrapper, args } = fixture(
      "rollback",
      { FIXTURE: "replacement" },
      true,
    );
    const publicationFailure = failure === "publication ownership";
    const originalFiles = [
      [plistPath, binaryPlist, mode],
      [envFile, Buffer.from("export FIXTURE='prior'\n"), 0o600],
      [wrapper, Buffer.from('#!/bin/sh\nexec "$@"\n'), 0o700],
    ] as const;
    for (const [file, contents, permissions] of originalFiles) {
      await writeFile(file, contents, permissions);
    }
    const publications: Array<{ contents: Buffer; mode: number }> = [];
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === plistPath) {
        publications.push(await readSnapshot(from));
      }
      await rename(from, to);
      const stat = await fs.stat(to);
      await fs.utimes(to, stat.atime, new Date(stat.mtimeMs + 10));
    });
    if (publicationFailure) {
      native.ownership.mockImplementation(async () => {
        if (!(await fs.readFile(plistPath)).equals(binaryPlist)) {
          throw new Error("synthetic ownership conflict");
        }
      });
    }
    const install = publicationFailure ? stageLaunchAgent : installLaunchAgent;
    await expect(install(args)).rejects.toThrow(
      publicationFailure ? "synthetic ownership conflict" : "synthetic activation refusal",
    );
    expect(publications.at(-1)).toEqual({ contents: binaryPlist, mode });
    for (const [file, contents, permissions] of originalFiles) {
      expect(await readSnapshot(file)).toEqual({ contents, mode: permissions });
    }
  });
});
