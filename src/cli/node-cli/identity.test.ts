import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../infra/device-identity.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { ExpectedCliError } from "../failure-output.js";
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

describe("node identity command", () => {
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

  it.each([false, true])("fails closed without minting an identity (json=%s)", async (json) => {
    const failure = await runNodeIdentity(json).catch((error: unknown) => error);
    const message =
      "no node device identity found (start the node host once with `openclaw node run` or `openclaw node install`)";
    expect(failure).toBeInstanceOf(ExpectedCliError);
    expect(failure).toMatchObject({ message, humanOutput: message, machineOutput: message });
    expectSilent();
    expect(defaultRuntime.writeStdout).not.toHaveBeenCalled();
    for (const file of ["client/credentials.sqlite", "state/openclaw.sqlite"]) {
      expect(fs.existsSync(path.join(stateDir, file))).toBe(false);
    }
  });

  it("writes deviceId and raw public key JSON to stdout", async () => {
    const identity = loadOrCreateDeviceIdentity();
    await closeOpenClawStateDatabaseAsync();
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    await runNodeIdentity(true);
    expect(prepare).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expectSilent();
    expect(defaultRuntime.writeStdout).toHaveBeenCalledOnce();
    expectIdentity(identity);
  });

  it("prints human-readable lines without --json", async () => {
    const identity = loadOrCreateDeviceIdentity();
    await runNodeIdentity();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    const calls = vi.mocked(defaultRuntime.log).mock.calls;
    const output = calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain(identity.deviceId);
    expect(output).toContain(publicKeyRawBase64UrlFromPem(identity.publicKeyPem));
  });
  it("selects an existing native profile without creating the default identity", async () => {
    const identity = loadOrCreateDeviceIdentity({ identityKey: "node" });
    await runNodeIdentity(true, "node");
    expectIdentity(identity);
    await expect(runNodeIdentity(false, "unknown")).rejects.toBeInstanceOf(ExpectedCliError);
  });

  function expectIdentity(identity: ReturnType<typeof loadOrCreateDeviceIdentity>) {
    expect(JSON.parse(stdout.join(""))).toEqual({
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    });
  }

  function expectSilent() {
    for (const method of ["error", "exit", "log"] as const) {
      expect(defaultRuntime[method]).not.toHaveBeenCalled();
    }
  }
});
