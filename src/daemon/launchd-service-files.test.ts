import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as exec from "../process/exec.js";
import { installLaunchAgent, stageLaunchAgent } from "./launchd-install.js";
import { readLaunchAgentProgramArgumentsFromFile } from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import { readLaunchAgentProgramArguments } from "./launchd-runtime.js";
import {
  readExistingLaunchAgentPlist,
  resolveLaunchAgentEnvironmentReadOptions,
  resolveLaunchAgentEnvFilePath,
  resolveLaunchAgentEnvWrapperPath,
  resolveLaunchAgentPlistPath,
  rewriteLaunchAgentPlistForRestart,
} from "./launchd-service-files.js";

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
function fixture(name: string, stateDir = false) {
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
    plistPath: resolveLaunchAgentPlistPath(env),
    wrapper: resolveLaunchAgentEnvWrapperPath(env, label),
    envFile: resolveLaunchAgentEnvFilePath(env, label),
  };
}
const programArguments = [
  "/opt/homebrew/opt/node@24/bin/node",
  "/opt/openclaw/dist/index.js",
  "gateway",
];
function stageArgs(env: Record<string, string>, environment: Record<string, string>) {
  return { env, stdout: new PassThrough(), programArguments, environment };
}
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
    if (!["print", "enable", "bootstrap"].includes(args[0] ?? "")) {
      throw new Error(`Unexpected launchctl command: ${args[0]}`);
    }
    return {
      stdout: "",
      stderr:
        args[0] === "print"
          ? "Could not find service"
          : args[0] === "bootstrap"
            ? "synthetic activation refusal"
            : "",
      code: args[0] === "print" ? 113 : args[0] === "bootstrap" ? 1 : 0,
      termination: "exit",
    };
  });
  vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Binary plist containing only a synthetic label, command, and inline environment value.
const binaryPlist = Buffer.from(
  "YnBsaXN0MDDVAQIDBAUGBwkMDFVMYWJlbF8QEFByb2dyYW1Bcmd1bWVudHNfEBRFbnZpcm9ubWVudFZhcmlhYmxlc1lSdW5BdExvYWRZS2VlcEFsaXZlXxAZYWkub3BlbmNsYXcucm9sbGJhY2stdGVzdKEIXS91c3IvYmluL3RydWXRCgtfEBBTWU5USEVUSUNfSU5MSU5FXxAVcHJpdmF0ZSBmaXh0dXJlIHZhbHVlCQgTGSxDTVdzdYOGmbEAAAAAAAABAQAAAAAAAAANAAAAAAAAAAAAAAAAAAAAsg==",
  "base64",
);

describe.skipIf(process.platform === "win32")("LaunchAgent file restoration", () => {
  it.each([
    {
      name: "three-line PEM",
      value: "-----BEGIN PRIVATE KEY-----  \nfixture\n-----END PRIVATE KEY-----",
    },
    { name: "escaped quotes and trailing newline", value: "first 'quoted'\nsecond 'line'\n" },
  ])("preserves $name through service readCommand and restart regeneration", async ({ value }) => {
    vi.spyOn(exec, "runExec").mockImplementation(async (file, args, options) => {
      if (file !== "/usr/bin/plutil" || typeof options !== "object" || !options.input) {
        throw new Error(`Unexpected native command: ${file}`);
      }
      return decodeLaunchAgentPlistFixture(options.input, args[1]);
    });
    const { env, label, plistPath, wrapper, envFile } = fixture("reinstall");
    const environment = { FIXTURE: value, NEXT: "retained" };
    const expected = { programArguments, environment };
    await stageLaunchAgent(stageArgs(env, { ...environment }));
    await expect(readLaunchAgentProgramArguments(env)).resolves.toMatchObject(expected);
    await rewriteLaunchAgentPlistForRestart({ env, label, plistPath });
    const plist = await fs.readFile(plistPath, "utf8");
    const array =
      plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "";
    const rawArguments = [...array.matchAll(/<string>(.*?)<\/string>/g)].map((match) => match[1]);
    expect(rawArguments).toEqual(["/bin/sh", wrapper, envFile, ...programArguments]);
    expect(
      await readLaunchAgentProgramArgumentsFromFile(plistPath, {
        ...resolveLaunchAgentEnvironmentReadOptions(env, label),
        requireEffective: true,
      }),
    ).toMatchObject(expected);
  });

  it("executes the installed env wrapper only with its generated readable environment", async () => {
    const { home, env, wrapper, envFile } = fixture("wrapper");
    const value = "literal ' value\nsecond line";
    await stageLaunchAgent({
      ...stageArgs(env, { FIXTURE: value }),
      programArguments: ["/bin/sh", "-c", 'printf "%s" "$FIXTURE"'],
    });
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
    const dir = dirs.make("launchd-snapshot-");
    const plistPath = path.join(dir, "gateway.plist");
    const replacementPath = path.join(dir, "replacement.plist");
    await writeFile(plistPath, binaryPlist, 0o600);
    await writeFile(replacementPath, "replacement", 0o644);
    const readFile = fs.readFile;
    const open = fs.open;
    let captured: Awaited<ReturnType<typeof fs.open>> | undefined;
    let replaced = false;
    const replacePath = async () => {
      if (!replaced) {
        replaced = true;
        await fs.rename(replacementPath, plistPath);
      }
    };
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const result = await readFile(...args);
      if (args[0] === plistPath) {
        await replacePath();
      }
      return result;
    });
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === plistPath) {
        captured = handle;
        await replacePath();
      }
      return handle;
    });
    expect(await readExistingLaunchAgentPlist(plistPath)).toEqual({
      contents: binaryPlist,
      mode: 0o600,
    });
    if (!captured) {
      throw new Error("Snapshot descriptor was not captured");
    }
    await expect(captured.stat()).rejects.toMatchObject({ code: "EBADF" });
    expect(await readFile(plistPath, "utf8")).toBe("replacement");
    expect((await fs.stat(plistPath)).mode & 0o7777).toBe(0o644);
  });

  it.each([
    { mode: 0o640, failure: "publication ownership" },
    { mode: 0o1600, failure: "install activation" },
  ])(
    "restores bytes and mode $mode before publication after $failure failure",
    async ({ mode, failure }) => {
      const { env, plistPath, envFile, wrapper } = fixture("rollback", true);
      const originalFiles = [
        { path: plistPath, contents: binaryPlist, mode },
        {
          path: envFile,
          contents: Buffer.from("export FIXTURE='prior'\n"),
          mode: 0o600,
        },
        {
          path: wrapper,
          contents: Buffer.from('#!/bin/sh\nexec "$@"\n'),
          mode: 0o700,
        },
      ];
      for (const file of originalFiles) {
        await writeFile(file.path, file.contents, file.mode);
      }
      const publications: Array<{ contents: Buffer; mode: number }> = [];
      const rename = fs.rename;
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (to === plistPath) {
          publications.push(await readSnapshot(from));
        }
        await rename(from, to);
      });
      if (failure === "publication ownership") {
        native.ownership.mockImplementation(async () => {
          if (!(await fs.readFile(plistPath)).equals(binaryPlist)) {
            throw new Error("synthetic ownership conflict");
          }
        });
      }
      const install = failure === "publication ownership" ? stageLaunchAgent : installLaunchAgent;
      await expect(
        install({
          ...stageArgs(env, { FIXTURE: "replacement" }),
          programArguments: ["/usr/bin/node", "/opt/openclaw/openclaw.mjs", "gateway"],
        }),
      ).rejects.toThrow(
        failure === "publication ownership"
          ? "synthetic ownership conflict"
          : "synthetic activation refusal",
      );
      expect(publications.at(-1)).toEqual({ contents: binaryPlist, mode });
      for (const file of originalFiles) {
        expect(await readSnapshot(file.path)).toEqual({ contents: file.contents, mode: file.mode });
      }
    },
  );
});
