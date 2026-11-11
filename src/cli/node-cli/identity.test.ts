import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../infra/device-identity.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { expectNoCalls } from "../daemon-cli/lifecycle-assertions.test-support.js";
import { ExpectedCliError } from "../expected-cli-error.js";
import { registerNodeCli } from "./register.js";

function runNodeIdentity(json = false, identity?: string) {
  const program = new Command().exitOverride();
  registerNodeCli(program);
  const args = ["node", "identity", ...(json ? ["--json"] : [])];
  if (identity) {
    args.push("--identity", identity);
  }
  return program.parseAsync(args, { from: "user" });
}

let stateDir: string;
let stdout: string[];
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-identity-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  stdout = [];
  for (const method of ["log", "error", "exit"] as const) {
    vi.spyOn(defaultRuntime, method).mockImplementation(() => {});
  }
  vi.spyOn(defaultRuntime, "writeStdout").mockImplementation((value) => stdout.push(value));
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value, space = 2) => {
    defaultRuntime.writeStdout(JSON.stringify(value, null, space > 0 ? space : undefined));
  });
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

it("fails closed without minting an identity", async () => {
  await expect(runNodeIdentity()).rejects.toThrow(ExpectedCliError);
  expectNoCalls(defaultRuntime.error, defaultRuntime.exit, defaultRuntime.log);
  expect(defaultRuntime.writeStdout).not.toHaveBeenCalled();
  for (const file of ["client/credentials.sqlite", "state/openclaw.sqlite"]) {
    expect(fs.existsSync(path.join(stateDir, file))).toBe(false);
  }
});

it.each([undefined, "node"])(
  "prints existing identity %s as JSON without database writes",
  async (identityKey) => {
    const identity = loadOrCreateDeviceIdentity({ identityKey });
    await closeOpenClawStateDatabaseAsync();
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    await runNodeIdentity(true, identityKey);
    expectNoCalls(prepare, exec, defaultRuntime.error, defaultRuntime.exit, defaultRuntime.log);
    expect(JSON.parse(stdout.join(""))).toEqual({
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    });
  },
);

it("prints human-readable lines without --json", async () => {
  const identity = loadOrCreateDeviceIdentity();
  await runNodeIdentity();
  expect(defaultRuntime.exit).not.toHaveBeenCalled();
  const calls = vi.mocked(defaultRuntime.log).mock.calls;
  const output = calls.map(([value]) => String(value)).join("\n");
  expect(output).toContain(identity.deviceId);
  expect(output).toContain(publicKeyRawBase64UrlFromPem(identity.publicKeyPem));
});

it("rejects an unknown identity profile", async () => {
  await expect(runNodeIdentity(false, "unknown")).rejects.toBeInstanceOf(ExpectedCliError);
});
