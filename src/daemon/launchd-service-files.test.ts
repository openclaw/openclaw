import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { installLaunchAgent } from "./launchd-install.js";
import {
  publishLaunchAgentPlist,
  readExistingLaunchAgentPlist,
  resolveLaunchAgentEnvFilePath,
  resolveLaunchAgentEnvWrapperPath,
  resolveLaunchAgentPlistPath,
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
  it("binds rollback bytes and permissions to one file and closes its descriptor", async () => {
    const dir = dirs.make("launchd-snapshot-");
    const plistPath = path.join(dir, "gateway.plist");
    const replacementPath = path.join(dir, "replacement.plist");
    await fs.writeFile(plistPath, binaryPlist, { mode: 0o600 });
    await fs.chmod(plistPath, 0o600);
    await fs.writeFile(replacementPath, "replacement", { mode: 0o644 });
    await fs.chmod(replacementPath, 0o644);
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

  it.each(
    [0o600, 0o640].flatMap((mode) =>
      ["publication ownership", "install activation"].map((failure) => ({ mode, failure })),
    ),
  )(
    "restores bytes and mode $mode before publication after $failure failure",
    async ({ mode, failure }) => {
      const home = dirs.make("launchd-rollback-files-");
      const label = "ai.openclaw.rollback-test";
      const env = {
        HOME: home,
        OPENCLAW_STATE_DIR: path.join(home, "state"),
        OPENCLAW_LAUNCHD_LABEL: label,
      };
      const plistPath = resolveLaunchAgentPlistPath(env);
      const originalFiles = [
        { path: plistPath, contents: binaryPlist, mode },
        {
          path: resolveLaunchAgentEnvFilePath(env, label),
          contents: Buffer.from("export FIXTURE='prior'\n"),
          mode: 0o600,
        },
        {
          path: resolveLaunchAgentEnvWrapperPath(env, label),
          contents: Buffer.from('#!/bin/sh\nexec "$@"\n'),
          mode: 0o700,
        },
      ];
      for (const file of originalFiles) {
        await fs.mkdir(path.dirname(file.path), { recursive: true });
        await fs.writeFile(file.path, file.contents);
        await fs.chmod(file.path, file.mode);
      }
      const publications: Array<{ contents: Buffer; mode: number }> = [];
      const rename = fs.rename;
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (to === plistPath) {
          publications.push({
            contents: await fs.readFile(from),
            mode: (await fs.stat(from)).mode & 0o7777,
          });
        }
        await rename(from, to);
      });
      const replacement = "synthetic replacement";
      if (failure === "publication ownership") {
        native.ownership.mockImplementation(async () => {
          if ((await fs.readFile(plistPath, "utf8")) === replacement) {
            throw new Error("synthetic ownership conflict");
          }
        });
      }
      await expect(
        failure === "publication ownership"
          ? publishLaunchAgentPlist({ label, plistPath, contents: replacement })
          : installLaunchAgent({
              env,
              stdout: new PassThrough(),
              programArguments: ["/usr/bin/node", "/opt/openclaw/openclaw.mjs", "gateway"],
              environment: { FIXTURE: "replacement" },
            }),
      ).rejects.toThrow(
        failure === "publication ownership"
          ? "synthetic ownership conflict"
          : "synthetic activation refusal",
      );
      expect(publications.at(-1)).toEqual({ contents: binaryPlist, mode });
      for (const file of originalFiles) {
        expect(await fs.readFile(file.path)).toEqual(file.contents);
        expect((await fs.stat(file.path)).mode & 0o7777).toBe(file.mode);
      }
    },
  );
});
