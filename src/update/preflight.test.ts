import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as runtimePaths from "../daemon/runtime-paths.js";
import * as serviceAccounts from "../daemon/systemd-service-account-command.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { preflight } from "./preflight.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["supported", "unsupported"] as const)(
  "checks Bun capabilities (%s), not the target's Node engine",
  async (status) => {
    await withOpenClawTestState({ label: "update-preflight-bun" }, async (state) => {
      vi.spyOn(runtimePaths, "resolveBunRuntimeInfo").mockResolvedValue({
        status,
        version: "1.4.5",
        sqliteVersion: status === "supported" ? "3.51.3" : "3.50.0",
        nodeSharedSqlite: false,
        sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
      });
      const result = await preflight({
        kind: "package",
        target: {
          kind: "package",
          spec: "openclaw@2026.11.21",
          version: "2026.11.21",
          engines: { node: ">=999" },
        },
        prefix: state.root,
        node: path.join(state.root, "bun"),
        statfs: async () => ({ bavail: 2_000_000_000, bsize: 1 }),
      });
      expect(result).toMatchObject(
        status === "supported" ? { ok: true } : { ok: false, reason: "bun-runtime-unsupported" },
      );
      if (!result.ok) {
        expect(result.message).toContain("Bun 1.4.4+ with WAL-reset-safe node:sqlite is required.");
      }
    });
  },
);

it.each<{
  label: string;
  owner: number;
  caller?: number;
  code?: string;
  outside?: boolean;
  home?: "root" | "prefix" | "missing";
  unknown?: boolean;
  symlinks?: boolean;
  missing?: boolean;
  inaccessible?: boolean;
  windows?: boolean;
  advice:
    | "chown"
    | "openclaw"
    | "uid 2000"
    | "sudo"
    | "permissions"
    | "readonly"
    | "generic"
    | "original";
}>([
  { label: "root-owned home prefix", owner: 0, advice: "chown" },
  { label: "EPERM home prefix", owner: 0, code: "EPERM", advice: "chown" },
  { label: "service-owned system prefix", owner: 2000, outside: true, advice: "openclaw" },
  { label: "service-owned home prefix", owner: 2000, advice: "openclaw" },
  {
    label: "unknown service account",
    owner: 2000,
    outside: true,
    unknown: true,
    advice: "uid 2000",
  },
  { label: "root-owned system prefix", owner: 0, outside: true, advice: "sudo" },
  { label: "root home", owner: 0, home: "root", advice: "sudo" },
  { label: "prefix equals home", owner: 0, home: "prefix", advice: "sudo" },
  { label: "missing home", owner: 0, home: "missing", advice: "sudo" },
  { label: "already-owned prefix", owner: 1000, advice: "permissions" },
  { label: "root caller", owner: 0, caller: 0, outside: true, advice: "permissions" },
  { label: "root caller with another owner", owner: 2000, caller: 0, advice: "generic" },
  { label: "read-only mount", owner: 0, code: "EROFS", advice: "readonly" },
  { label: "symlinked home and prefix", owner: 0, symlinks: true, advice: "chown" },
  { label: "missing prefix", owner: 0, missing: true, advice: "chown" },
  { label: "untraversable prefix", owner: 0, inaccessible: true, advice: "original" },
  { label: "Windows system prefix", owner: 0, outside: true, windows: true, advice: "generic" },
])("reports safe ownership guidance: $label", async (test) => {
  await withOpenClawTestState({ label: "update-preflight-owner" }, async (state) => {
    const home = state.home;
    const directory = path.join(test.outside ? state.root : home, "user's install");
    await fs.mkdir(directory);
    const resolved = await fs.realpath(directory);
    let prefix = test.missing ? path.join(directory, "missing") : directory;
    let homedir = home;
    if (test.home === "root") {
      homedir = path.parse(home).root;
    } else if (test.home === "prefix") {
      homedir = directory;
    } else if (test.home === "missing") {
      homedir = path.join(home, "missing");
    }
    if (test.symlinks) {
      homedir = path.join(state.root, "home-link");
      prefix = path.join(state.root, "prefix-link");
      await fs.symlink(home, homedir, "junction");
      await fs.symlink(directory, prefix, "junction");
    }
    vi.spyOn(os, "userInfo").mockReturnValue({
      ...os.userInfo(),
      uid: test.caller ?? 1000,
      username: "domain\\update user",
      homedir: test.outside && test.owner !== 0 ? path.join(home, "missing") : homedir,
    });
    const stat = await fs.stat(directory);
    const originalStat = fs.stat.bind(fs);
    vi.spyOn(fs, "stat").mockImplementation(async (file) =>
      file === resolved
        ? Object.assign(stat, { uid: test.owner, mode: 0o40555 })
        : originalStat(file),
    );
    const lookup = vi.spyOn(serviceAccounts, "resolveServiceAccountName");
    if (test.unknown) {
      lookup.mockRejectedValue(new Error("no account"));
    } else {
      lookup.mockResolvedValue("openclaw");
    }
    const access = fs.access.bind(fs);
    const error = Object.assign(new Error("permission denied"), { code: test.code ?? "EACCES" });
    vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
      if (
        (test.inaccessible || mode === constants.W_OK) &&
        (file === prefix || file === directory)
      ) {
        throw error;
      }
      return access(file, mode);
    });
    vi.stubGlobal("process", { ...process, platform: test.windows ? "win32" : "linux" });
    const result = await preflight({
      kind: "package",
      target: { kind: "package", spec: "openclaw@2026.11.21", version: "2026.11.21" },
      prefix,
    });
    const messages = {
      chown: `Files in '${resolved}' are not writable by domain\\update user. Fix ownership with: sudo chown -R 'domain\\update user' '${resolved.replaceAll("'", `'"'"'`)}'. Then retry the update.`,
      openclaw: `'${resolved}' is owned by openclaw; update as that user, or run sudo openclaw update.`,
      "uid 2000": `'${resolved}' is owned by uid 2000; update as that user, or run sudo openclaw update.`,
      sudo: `The installation at '${resolved}' is owned by root. Run: sudo openclaw update`,
      permissions: `'${resolved}' is owned by you but not writable; check its permissions or read-only filesystem.`,
      readonly: `'${resolved}' is on a read-only filesystem.`,
      generic: `'${resolved}' is not writable; check its permissions or read-only filesystem.`,
      original: "permission denied",
    };
    expect(result).toEqual({
      ok: false,
      reason: "prefix-not-writable",
      message: messages[test.advice],
    });
    if (test.windows || test.caller === 0 || test.owner === 1000) {
      expect(lookup).not.toHaveBeenCalled();
    }
  });
});
