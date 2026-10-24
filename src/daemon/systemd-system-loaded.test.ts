import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import type { ExecResult } from "./exec-file.js";
const exec = vi.hoisted(() => vi.fn<typeof import("./exec-file.js").execFileUtf8>());
vi.mock("./exec-file.js", () => ({ execFileUtf8: exec }));
import { readSystemdDefinitionMutationCapability } from "./systemd-definition-mutation.js";
import { nativeExit } from "./systemd-exec.test-support.js";
import {
  admitUserUnitActivationPastUnverifiableOwnership,
  isSystemdServiceAbsent,
} from "./systemd-scope.js";
import { assertNoSystemSystemdOwnership } from "./systemd-system.js";

const unit = "openclaw-owned.service";
const owner = ":1.4";
const home = "/openclaw-systemd-cleanup-proof";
const env = { HOME: home, OPENCLAW_SYSTEMD_UNIT: unit };
const notFound = () => Object.assign(new Error("missing"), { code: "ENOENT" });
const commandResult = (stdout = "", stderr = "", code = 0): ExecResult =>
  nativeExit(stdout, stderr, code);
const success = (type: string, data: unknown) => commandResult(JSON.stringify({ type, data }));
const missing = () => commandResult("", `Call failed: Unit ${unit} not loaded.`, 1);
function reply(args: readonly string[]): ExecResult {
  if (args.includes("GetNameOwner")) {
    return success("s", [owner]);
  }
  if (args.includes("GetUnit")) {
    return missing();
  }
  if (args.includes("UnitPath")) {
    return success("as", ["/etc/systemd/system", "/run/systemd/system"]);
  }
  throw new Error("Unexpected manager query");
}
const absent = () => assertNoSystemSystemdOwnership(unit, 1000, { requireLoaded: true });
beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(fs, "lstat").mockRejectedValue(notFound());
  exec.mockReset().mockImplementation(async (_command, args) => reply(args));
});
afterEach(() => vi.restoreAllMocks());

const cleanupSources = ["absence", "system", "user", "loaded-user", "activation"] as const;
it.each(cleanupSources)("propagates %s cleanup errors", async (source) => {
  const error = new CommandProcessCleanupError();
  exec.mockImplementation(async (_command, args) => {
    if (["absence", "system", "activation"].includes(source) || !args.includes("--system")) {
      throw error;
    }
    if (source === "loaded-user") {
      throw new Error("system manager unavailable");
    }
    return reply(args);
  });

  let probe: Promise<unknown>;
  if (source === "absence") {
    probe = isSystemdServiceAbsent(env, { strictCommandAbsent: true, timeoutMs: 1000 });
  } else if (source === "activation") {
    exec.mockRejectedValueOnce(new Error("system manager unavailable"));
    const refusal: unknown = await absent().catch((cause: unknown) => cause);
    expect(refusal).toMatchObject({ ownership: { status: "unverifiable" } });
    probe = admitUserUnitActivationPastUnverifiableOwnership(env, refusal);
  } else {
    vi.spyOn(fs, "readFile").mockRejectedValue(notFound());
    probe = readSystemdDefinitionMutationCapability(
      {
        ...env,
        OPENCLAW_STATE_DIR: `${home}/state`,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/${source}/bus`,
      },
      {
        requireLoaded: true,
        systemdReadTarget: { scope: "user", unitName: unit, unitPath: "/unused/unit" },
      },
    );
  }
  await expect(probe).rejects.toBe(error);
});

it("proves absence using the existing manager and load paths without activation", async () => {
  await expect(absent()).resolves.toBeUndefined();
  expect(exec).toHaveBeenCalledTimes(3);
  for (const [command, args] of exec.mock.calls) {
    expect(command).toBe("busctl");
    expect(args).toEqual(expect.arrayContaining(["--system", "--auto-start=no"]));
    expect(args).not.toContain("LoadUnit");
    if (!args.includes("GetNameOwner")) {
      expect(args).toContain(owner);
    }
  }
  expect(fs.lstat).toHaveBeenCalledWith(`/etc/systemd/system/${unit}`);
  expect(fs.lstat).toHaveBeenCalledWith(`/run/systemd/system/${unit}`);
});
it("refuses filesystem uncertainty", async () => {
  vi.spyOn(fs, "lstat").mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
  await expect(absent()).rejects.toMatchObject({
    ownership: { status: "unverifiable", operation: "filesystem" },
  });
});
it.each([
  { name: "invalid object path", result: success("o", ["/unexpected"]) },
  { name: "timed out missing", result: { ...missing(), termination: "timeout" as const } },
])("rejects $name rather than certifying absence", async ({ result }) => {
  exec.mockImplementation(async (_command, args) =>
    args.includes("GetUnit") ? result : reply(args),
  );
  await expect(absent()).rejects.toMatchObject({ ownership: { status: "unverifiable" } });
});
