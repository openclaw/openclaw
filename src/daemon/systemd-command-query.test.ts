import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const busctl = vi.hoisted(() => vi.fn());
vi.mock("./systemd-exec.js", async (original) => ({
  ...(await original<typeof import("./systemd-exec.js")>()),
  execBusctlUser: busctl,
  bindSystemdManagerOwner: vi.fn(),
  systemdInspectionError: (_result: unknown, message: string) => new Error(message),
}));

import { createSystemdCommandQuery } from "./systemd-command-query.js";
import { readSystemdServiceExecStart } from "./systemd-service-files.js";

const queryEnv = { XDG_RUNTIME_DIR: "/run/user/1234" };
const unitName = "openclaw-gateway.service";
const callArgs = ["call", "org.test", "/unitName", "org.test.Manager", "LoadUnit", "s", unitName];
const unavailable = () => new Error("inspection unavailable");
const reader = (options?: Parameters<typeof createSystemdCommandQuery>[2]) =>
  createSystemdCommandQuery(queryEnv, unitName, options, unavailable);
const query = async (options?: Parameters<typeof createSystemdCommandQuery>[2]) =>
  (await reader(options)).query(callArgs, ["o"]);
const success = (stdout: string) => ({ code: 0, termination: "exit" as const, stdout, stderr: "" });
const failure = (stderr: string) => ({ ...success(""), code: 1, stderr });
const unsupported = failure("busctl: unrecognized option '--json=short'");

beforeEach(() => {
  busctl.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("systemd command query legacy compatibility", () => {
  it("retains legacy mode only for this reader", async () => {
    busctl.mockResolvedValueOnce(unsupported).mockResolvedValue(success('o "/unitName"'));
    const legacy = await reader();
    await expect(legacy.query(callArgs, ["o"])).resolves.toEqual([["/unitName"]]);
    await legacy.query(callArgs, ["o"]);
    expect(busctl.mock.calls[0]?.slice(0, 2)).toEqual([queryEnv, ["--json=short", ...callArgs]]);
    expect(busctl.mock.calls[1]?.slice(0, 2)).toEqual([queryEnv, callArgs]);
    expect(busctl.mock.calls[2]?.[1]).not.toContain("--json=short");
    busctl.mockResolvedValueOnce(success('{"type":"o","data":["/unitName"]}'));
    await query();
    expect(busctl.mock.calls[3]?.[1]).toContain("--json=short");
  });

  it.each([
    [false, { ...unsupported, stderr: "Call failed: Access denied" }],
    [false, { ...unsupported, termination: "timeout" }],
    [false, { ...unsupported, stdout: "unexpected output" }],
    [false, { ...unsupported, stderr: "busctl: unrecognized option '--auto-start=no'" }],
    [false, { ...unsupported, stderr: "prefix: busctl: unrecognized option '--json=short'" }],
    [false, success("malformed successful reply")],
    [true, { ...success('o "/unitName"'), code: 1, stderr: "Call failed: Access denied" }],
    [true, { ...success('o "/unitName"'), termination: "timeout" }],
  ])("rejects failure (legacy=%s): %j", async (legacy, result) => {
    if (legacy) {
      busctl.mockResolvedValueOnce(unsupported);
    }
    busctl.mockResolvedValue(result);
    await expect(query()).rejects.toThrow();
    expect(busctl).toHaveBeenCalledTimes(legacy ? 2 : 1);
  });

  it.each([
    { first: 200, retry: 0, budgets: [1000, 800], ok: true },
    { first: 1000, retry: 0, budgets: [1000], ok: false },
    { first: 0, retry: 1000, budgets: [1000, 1000], ok: false },
  ])("shares the original call deadline: %j", async ({ first, retry, budgets, ok }) => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    busctl
      .mockImplementationOnce(async () => {
        now += first;
        return unsupported;
      })
      .mockImplementationOnce(async () => {
        now += retry;
        return success('o "/unitName"');
      });
    const result = query({ timeoutMs: 3000 });
    if (ok) {
      await expect(result).resolves.toEqual([["/unitName"]]);
    } else {
      await expect(result).rejects.toThrow();
    }
    expect(busctl.mock.calls.map((call) => call[2])).toEqual(budgets);
  });

  it("preserves non-activating reads and rejects revoked inspection before retry", async () => {
    let current = true;
    const assertCurrent = vi.fn(() => {
      if (!current) {
        throw unavailable();
      }
    });
    const options = { requireLoaded: true, loadForInspection: { managerUid: 1234, assertCurrent } };
    const inspected = await reader(options);
    busctl.mockImplementationOnce(async () => {
      current = false;
      return unsupported;
    });
    await expect(inspected.query(callArgs, ["o"])).rejects.toThrow();
    expect(busctl).toHaveBeenCalledTimes(1);
    expect(busctl.mock.calls[0]?.[1]).toEqual(["--json=short", "--auto-start=no", ...callArgs]);
    expect(busctl.mock.calls[0]?.[3]).toBe(assertCurrent);
  });
});

describe("effective service inspection through legacy busctl", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  let env: Record<string, string>;
  let unit: string;
  let dropIn: string;
  let requiredFile: string;
  let pendingReload: boolean;
  let malformed: boolean;
  const inspect = () => readSystemdServiceExecStart(env, { requireEffective: true });

  beforeEach(async () => {
    const home = await fs.realpath(dirs.make("openclaw-systemd-legacy-"));
    env = { HOME: home, OPENCLAW_SYSTEMD_UNIT: "openclaw-legacy" };
    unit = path.join(home, ".config/systemd/user/openclaw-legacy.service");
    dropIn = `${unit}.d/override.conf`;
    requiredFile = path.join(home, "required.env");
    await fs.mkdir(path.dirname(dropIn), { recursive: true });
    await fs.writeFile(unit, "[Service]\nExecStart=/local/file gateway\n");
    await fs.writeFile(dropIn, "[Service]\nEnvironment=KEEP=override\n");
    await fs.writeFile(requiredFile, "A=file\nREMOVE=yes\nKEEP=file\n");
    pendingReload = false;
    malformed = false;
    busctl.mockImplementation(async (_env, args: string[]) => {
      if (args.includes("--json=short")) {
        return unsupported;
      }
      if (args.includes("LoadUnit")) {
        return success('o "/org/freedesktop/systemd1/unit/openclaw_2dlegacy_2eservice"\n');
      }
      if (args.includes("org.freedesktop.systemd1.Unit")) {
        return success(
          `s ${JSON.stringify(unit)}\nas 1 ${JSON.stringify(dropIn)}\nb ${pendingReload}\ns "loaded"\n`,
        );
      }
      return success(
        malformed
          ? 'a(sasbttttuii) 1 "broken"'
          : [
              String.raw`a(sasbttttuii) 1 "/usr/bin/node" 4 "/usr/bin/node" "gateway" "caf\303\251" "quoted \"value\" \\ path" false 0 0 0 0 0 0 0`,
              `s ${JSON.stringify(env.HOME)}`,
              'as 2 "A=inline" "REMOVE=yes"',
              `a(sb) 2 ${JSON.stringify(requiredFile)} false ${JSON.stringify(path.join(env.HOME!, "optional.env"))} true`,
              'as 1 "REMOVE"',
            ].join("\n"),
      );
    });
  });

  it.each([false, true])(
    "retains manager data and selected drop-ins with reloadPending=%s",
    async (reload) => {
      pendingReload = reload;
      const actual = await inspect();
      expect(actual).toMatchObject({
        programArguments: ["/usr/bin/node", "gateway", "café", 'quoted "value" \\ path'],
        workingDirectory: env.HOME,
        environment: { A: "file", KEEP: "file" },
        sourcePath: unit,
        definitionPaths: [unit, dropIn],
      });
      expect(actual?.environment).not.toHaveProperty("REMOVE");
      expect(actual?.reloadPending).toBe(reload || undefined);
      expect(busctl).toHaveBeenCalledTimes(4);
    },
  );

  it.each(["missing required file", "malformed reply"])(
    "rejects %s despite a readable local unit",
    async (reason) => {
      malformed = reason === "malformed reply";
      if (!malformed) {
        await fs.unlink(requiredFile);
      }
      await expect(inspect()).rejects.toThrow();
    },
  );

  it("accepts exact absence for a fresh installation without manufacturing a command", async () => {
    await fs.unlink(unit);
    busctl.mockImplementation(async (_env, args: string[]) =>
      failure(
        args.includes("--json=short")
          ? unsupported.stderr
          : "Call failed: Unit openclaw-legacy.service not found.",
      ),
    );
    await expect(inspect()).resolves.toBeNull();
  });
});
