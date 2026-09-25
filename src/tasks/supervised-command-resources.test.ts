import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  run: vi.fn(),
  processState: vi.fn(),
  read: vi.fn(),
  open: vi.fn(),
  stat: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({ runCommandBuffered: host.run }));
vi.mock("../node-host/node-worker-process-identity.js", () => ({
  inspectNodeWorkerProcessIdentity: host.processState,
}));
vi.mock("node:fs", () => ({
  default: {
    constants: { O_RDONLY: 0, O_DIRECTORY: 65536, O_NOFOLLOW: 131072 },
    readFileSync: host.read,
    openSync: host.open,
    fstatSync: host.stat,
    closeSync: host.close,
  },
}));

import {
  buildSupervisedCommandScopeArgv,
  inspectSupervisedCommandScope,
  isSealedSupervisedCommandScopeAbsent,
  isSupervisedCommandBootRetired,
  isSupervisedCommandScopeClosed,
  terminateSupervisedCommandScope,
  type SupervisedCommandScopeIdentity,
} from "./supervised-command-resources.js";

const executionId = "4aa8e216-9867-49da-b173-4a8d8e5133bf";
const machineId = "e54e6bba807e4f3f96c95ec68cd752df";
const scopeName = `openclaw-task-${executionId}.scope`;
const uid = process.getuid?.();
const controlGroup = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${scopeName}`;
const identity: SupervisedCommandScopeIdentity = {
  executionId,
  scopeName,
  controlGroup,
  invocationId: "a".repeat(32),
  hostId: createHash("sha256").update(machineId).digest("hex"),
  bootId: "17942485-e718-4970-ac7a-e06f5a79de81",
  cgroupDevice: "29",
  cgroupInode: "1203",
  custodian: { pid: 321, startTime: 87000 },
  limits: { memoryBytes: 67108864, tasks: 32 },
};

function response(overrides: Record<string, string> = {}) {
  return {
    stdout: Buffer.from(
      Object.entries({
        Id: scopeName,
        LoadState: "loaded",
        ActiveState: "active",
        InvocationID: identity.invocationId,
        ControlGroup: controlGroup,
        ...overrides,
      })
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    ),
    stderr: Buffer.alloc(0),
    termination: "exit",
    code: 0,
  };
}

let files: Record<string, string>;
beforeEach(() => {
  vi.resetAllMocks();
  files = {
    "/etc/machine-id": `${machineId}\n`,
    "/proc/sys/kernel/random/boot_id": identity.bootId,
    "/proc/321/cgroup": `0::${controlGroup}\n`,
    "/proc/self/fd/10/memory.max": "67108864\n",
    "/proc/self/fd/10/memory.swap.max": "0\n",
    "/proc/self/fd/10/pids.max": "32\n",
    "/proc/self/fd/10/cgroup.events": "populated 1\nfrozen 0\n",
  };
  host.read.mockImplementation((file: string) => {
    if (!(file in files)) {
      throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
    }
    return files[file];
  });
  host.run.mockResolvedValue(response());
  host.processState.mockReturnValue("live");
  host.open.mockReturnValue(10);
  host.stat.mockReturnValue({ dev: 29n, ino: 1203n, isDirectory: () => true });
});

describe.skipIf(process.platform !== "linux")("supervised command resource ownership", () => {
  const inspect = (assertCurrent = () => {}) =>
    inspectSupervisedCommandScope({
      executionId,
      limits: identity.limits,
      expectedProcess: identity.custodian,
      assertCurrent,
    });

  it("binds the gated custodian to actual kernel limits and a serializable cgroup identity", async () => {
    const observed = await inspect();
    const serialized = JSON.stringify(observed);
    expect(JSON.parse(serialized)).toEqual(identity);
  });

  it("retires the previous boot on the same host without consulting or signaling current units", async () => {
    files["/proc/sys/kernel/random/boot_id"] = "235686a8-f660-4418-a4a8-4f38705302dc";
    host.run.mockRejectedValue(new Error("current manager unavailable"));
    expect(isSupervisedCommandBootRetired(identity)).toBe(true);
    await expect(isSupervisedCommandScopeClosed(identity)).resolves.toBe(true);
    const assertCleanupCurrent = vi.fn();
    await expect(
      terminateSupervisedCommandScope(identity, assertCleanupCurrent),
    ).resolves.toBeUndefined();
    expect(assertCleanupCurrent).toHaveBeenCalled();
    expect(host.run).not.toHaveBeenCalled();
    expect(host.open).not.toHaveBeenCalled();
    expect(host.processState).not.toHaveBeenCalled();
  });

  it("does not retire an old boot when the installation identity belongs to a different host", async () => {
    files["/etc/machine-id"] = "388fab9b85f540238025aec2c302bada\n";
    files["/proc/sys/kernel/random/boot_id"] = "235686a8-f660-4418-a4a8-4f38705302dc";
    expect(() => isSupervisedCommandBootRetired(identity)).toThrow("execution host");
    await expect(isSupervisedCommandScopeClosed(identity)).rejects.toThrow("execution host");
    await expect(terminateSupervisedCommandScope(identity, () => {})).rejects.toThrow(
      "execution host",
    );
    expect(host.run).not.toHaveBeenCalled();
    expect(host.open).not.toHaveBeenCalled();
  });

  it.each(["", "uninitialized", "0".repeat(32), "a".repeat(33)])(
    "rejects unavailable or malformed host installation evidence %j",
    async (value) => {
      files["/etc/machine-id"] = value;
      await expect(inspect()).rejects.toThrow("host installation identity unavailable");
      await expect(isSupervisedCommandScopeClosed(identity)).rejects.toThrow(
        "host installation identity unavailable",
      );
      expect(host.run).not.toHaveBeenCalled();
    },
  );

  it("keeps closure unknown when the host identity file is missing", async () => {
    delete files["/etc/machine-id"];
    await expect(isSupervisedCommandScopeClosed(identity)).rejects.toThrow("missing fixture");
    await expect(terminateSupervisedCommandScope(identity, () => {})).rejects.toThrow(
      "missing fixture",
    );
    expect(host.run).not.toHaveBeenCalled();
  });

  it.each(["missing host", "malformed host", "malformed boot", "malformed custodian"])(
    "rejects a stored identity with %s before considering boot retirement",
    async (fault) => {
      const invalid = { ...identity, custodian: { ...identity.custodian } };
      if (fault === "missing host") {
        Reflect.deleteProperty(invalid, "hostId");
      } else if (fault === "malformed host") {
        invalid.hostId = "not-a-host-digest";
      } else if (fault === "malformed boot") {
        invalid.bootId = "old-boot";
      } else {
        invalid.custodian.pid = -1;
      }
      files["/proc/sys/kernel/random/boot_id"] = "235686a8-f660-4418-a4a8-4f38705302dc";
      expect(() => isSupervisedCommandBootRetired(invalid)).toThrow("execution host");
      await expect(isSupervisedCommandScopeClosed(invalid)).rejects.toThrow("execution host");
      await expect(terminateSupervisedCommandScope(invalid, () => {})).rejects.toThrow(
        "execution host",
      );
      expect(host.run).not.toHaveBeenCalled();
    },
  );

  it("does not signal a current unit if a same-host boot transition is observed during inspection", async () => {
    host.run.mockImplementation(async () => {
      files["/proc/sys/kernel/random/boot_id"] = "235686a8-f660-4418-a4a8-4f38705302dc";
      return response({ InvocationID: "b".repeat(32) });
    });
    await expect(terminateSupervisedCommandScope(identity, () => {})).resolves.toBeUndefined();
    expect(host.run.mock.calls.some(([argv]) => argv.includes("kill"))).toBe(false);
    expect(host.open).not.toHaveBeenCalled();
  });

  it.each([
    ["memory.max", "max"],
    ["memory.swap.max", "1073741824"],
    ["pids.max", "max"],
  ])("refuses to admit when actual %s is weaker than requested", async (name, value) => {
    files[`/proc/self/fd/10/${name}`] = value;
    await expect(inspect()).rejects.toThrow("kernel limit");
  });

  it.each(["reused", "unknown", "dead"])(
    "refuses a %s custodian process identity",
    async (state) => {
      host.processState.mockReturnValue(state);
      await expect(inspect()).rejects.toThrow("process identity");
    },
  );

  it("does not accept a live process in the Gateway's cgroup", async () => {
    files["/proc/321/cgroup"] =
      `0::/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/openclaw-gateway.service`;
    await expect(inspect()).rejects.toThrow("exact reserved scope");
  });

  it("rejects an invocation replaced during the admission inspection", async () => {
    host.run
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ InvocationID: "b".repeat(32) }));
    await expect(inspect()).rejects.toThrow("invocation or cgroup changed");
  });

  it("rechecks owner authority after awaited manager observation", async () => {
    let current = true;
    host.run.mockImplementation(async () => {
      current = false;
      return response();
    });
    await expect(
      inspect(() => {
        if (!current) {
          throw new Error("owner revoked");
        }
      }),
    ).rejects.toThrow("owner revoked");
  });

  it("does not infer extinction from a failed unit whose descendants remain", async () => {
    host.run.mockResolvedValue(response({ ActiveState: "failed" }));
    await expect(isSupervisedCommandScopeClosed(identity)).resolves.toBe(false);
  });

  it("accepts observed recursive emptiness of the exact cgroup", async () => {
    files["/proc/self/fd/10/cgroup.events"] = "populated 0\nfrozen 0\n";
    await expect(isSupervisedCommandScopeClosed(identity)).resolves.toBe(true);
  });

  it("rejects a replacement kernel cgroup at the same pathname", async () => {
    files["/proc/self/fd/10/cgroup.events"] = "populated 0\n";
    host.stat.mockReturnValue({ dev: 29n, ino: 1204n, isDirectory: () => true });
    await expect(isSupervisedCommandScopeClosed(identity)).rejects.toThrow(
      "kernel identity changed",
    );
  });

  it("requires matching manager retirement as well as an absent kernel cgroup", async () => {
    host.open.mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });
    await expect(isSupervisedCommandScopeClosed(identity)).rejects.toThrow(
      "without matching scope retirement",
    );
    host.run.mockResolvedValue(response({ ActiveState: "inactive", ControlGroup: "" }));
    await expect(isSupervisedCommandScopeClosed(identity)).resolves.toBe(true);
    host.run.mockResolvedValue(
      response({ ActiveState: "inactive", ControlGroup: "", InvocationID: "b".repeat(32) }),
    );
    await expect(isSupervisedCommandScopeClosed(identity)).rejects.toThrow(
      "invocation or cgroup changed",
    );
  });

  it("does not accept collected-unit metadata while its cgroup is still populated", async () => {
    host.run.mockResolvedValue(
      response({
        LoadState: "not-found",
        ActiveState: "inactive",
        InvocationID: "",
        ControlGroup: "",
      }),
    );
    await expect(isSupervisedCommandScopeClosed(identity)).rejects.toThrow(
      "invocation or cgroup changed",
    );
    host.open.mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });
    await expect(isSupervisedCommandScopeClosed(identity)).resolves.toBe(true);
  });

  it("reconciles collection between manager inspection and cgroup open", async () => {
    host.open.mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });
    host.run.mockResolvedValueOnce(response()).mockResolvedValueOnce(
      response({
        LoadState: "not-found",
        ActiveState: "inactive",
        InvocationID: "",
        ControlGroup: "",
      }),
    );
    await expect(isSupervisedCommandScopeClosed(identity)).resolves.toBe(true);
  });

  it("never converts a failed manager query into extinction", async () => {
    host.run.mockResolvedValue({ ...response(), termination: "timeout", code: null });
    files["/proc/self/fd/10/cgroup.events"] = "populated 0\n";
    await expect(isSupervisedCommandScopeClosed(identity)).rejects.toThrow(
      "manager identity unavailable",
    );
  });

  it("observes sealed-plan absence only from exact collected-unit metadata", async () => {
    await expect(isSealedSupervisedCommandScopeAbsent(executionId)).resolves.toBe(false);
    host.open.mockClear();
    host.run.mockResolvedValue(
      response({ LoadState: "not-found", InvocationID: "", ControlGroup: "" }),
    );
    await expect(isSealedSupervisedCommandScopeAbsent(executionId)).resolves.toBe(true);
    host.run.mockResolvedValue(response({ LoadState: "not-found", ControlGroup: "" }));
    await expect(isSealedSupervisedCommandScopeAbsent(executionId)).resolves.toBe(false);
    host.run.mockResolvedValue(response({ LoadState: "not-found", InvocationID: "" }));
    await expect(isSealedSupervisedCommandScopeAbsent(executionId)).resolves.toBe(false);
    host.run.mockResolvedValue({ ...response(), termination: "timeout", code: null });
    await expect(isSealedSupervisedCommandScopeAbsent(executionId)).rejects.toThrow(
      "manager identity unavailable",
    );
    expect(host.run.mock.calls.some(([argv]) => argv.includes("kill"))).toBe(false);
    expect(host.open).not.toHaveBeenCalled();
  });

  it("observes an empty retained unit only with stable manager and pinned kernel identity", async () => {
    files["/proc/self/fd/10/cgroup.events"] = "populated 0\nfrozen 0\n";
    files["/proc/self/fd/11/cgroup.events"] = "populated 0\nfrozen 0\n";
    host.open.mockReturnValueOnce(10).mockReturnValueOnce(11);
    host.run.mockResolvedValueOnce(response()).mockImplementationOnce(async () => {
      // Keep the first inode pinned across the asynchronous manager recheck.
      expect(host.close).not.toHaveBeenCalled();
      return response();
    });
    await expect(isSealedSupervisedCommandScopeAbsent(executionId)).resolves.toBe(true);
    expect(host.run).toHaveBeenCalledTimes(2);
    expect(host.close.mock.calls).toEqual([[11], [10]]);
    expect(host.run.mock.calls.every(([argv]) => argv.includes("show"))).toBe(true);
  });

  it("does not release a retained unit when descendants arrive during revalidation", async () => {
    files["/proc/self/fd/10/cgroup.events"] = "populated 0\n";
    files["/proc/self/fd/11/cgroup.events"] = "populated 1\n";
    host.open.mockReturnValueOnce(10).mockReturnValueOnce(11);
    await expect(isSealedSupervisedCommandScopeAbsent(executionId)).resolves.toBe(false);
    expect(host.run).toHaveBeenCalledTimes(2);
  });

  it.each<Record<string, string>>([
    { InvocationID: "b".repeat(32) },
    { ControlGroup: controlGroup.replace("app.slice", "background.slice") },
    { LoadState: "not-found", InvocationID: "", ControlGroup: "" },
  ])("rejects retained-unit replacement during manager revalidation: %j", async (changed) => {
    files["/proc/self/fd/10/cgroup.events"] = "populated 0\n";
    host.run.mockResolvedValueOnce(response()).mockResolvedValueOnce(response(changed));
    await expect(isSealedSupervisedCommandScopeAbsent(executionId)).rejects.toThrow();
    expect(host.close).toHaveBeenCalledWith(10);
  });

  it.each(["device", "inode"])("rejects a replaced retained cgroup %s", async (changed) => {
    files["/proc/self/fd/10/cgroup.events"] = "populated 0\n";
    files["/proc/self/fd/11/cgroup.events"] = "populated 0\n";
    host.open.mockReturnValueOnce(10).mockReturnValueOnce(11);
    host.stat
      .mockReturnValueOnce({ dev: 29n, ino: 1203n, isDirectory: () => true })
      .mockReturnValueOnce({
        dev: changed === "device" ? 30n : 29n,
        ino: changed === "inode" ? 1204n : 1203n,
        isDirectory: () => true,
      });
    await expect(isSealedSupervisedCommandScopeAbsent(executionId)).rejects.toThrow();
    expect(host.close.mock.calls).toEqual([[11], [10]]);
  });

  it.each<Record<string, string>>([
    { InvocationID: "invalid" },
    { ControlGroup: `/foreign/${scopeName}` },
    { ControlGroup: controlGroup.replace(scopeName, "other.scope") },
  ])("rejects malformed retained-unit identity before a kernel read: %j", async (invalid) => {
    host.run.mockResolvedValue(response(invalid));
    await expect(isSealedSupervisedCommandScopeAbsent(executionId)).rejects.toThrow();
    expect(host.open).not.toHaveBeenCalled();
  });

  it.each(["InvocationID", "ControlGroup"])("rejects a missing %s observation", async (field) => {
    const observed = response();
    observed.stdout = Buffer.from(
      observed.stdout
        .toString()
        .split("\n")
        .filter((line) => !line.startsWith(`${field}=`))
        .join("\n"),
    );
    host.run.mockResolvedValue(observed);
    await expect(isSealedSupervisedCommandScopeAbsent(executionId)).rejects.toThrow();
    expect(host.open).not.toHaveBeenCalled();
  });

  it.each(["frozen 0\n", "populated 0\npopulated 1\n", "populated unknown\n"])(
    "rejects incomplete recursive population evidence %j",
    async (events) => {
      files["/proc/self/fd/10/cgroup.events"] = events;
      await expect(isSealedSupervisedCommandScopeAbsent(executionId)).rejects.toThrow();
      expect(host.close).toHaveBeenCalledWith(10);
    },
  );

  it("does not signal after cleanup authority is revoked during inspection", async () => {
    let current = true;
    host.run.mockImplementation(async () => {
      current = false;
      return response();
    });
    await expect(
      terminateSupervisedCommandScope(identity, () => {
        if (!current) {
          throw new Error("cleanup owner revoked");
        }
      }),
    ).rejects.toThrow("cleanup owner revoked");
    expect(host.run.mock.calls.some(([argv]) => argv.includes("kill"))).toBe(false);
  });

  it("refuses to signal an invocation replaced after the population check", async () => {
    host.run
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ InvocationID: "b".repeat(32) }));
    await expect(terminateSupervisedCommandScope(identity, () => {})).rejects.toThrow(
      "invocation or cgroup changed",
    );
    expect(host.run.mock.calls.some(([argv]) => argv.includes("kill"))).toBe(false);
  });

  it("reconciles an uncertain signal without blindly issuing another mutation", async () => {
    host.run.mockImplementation(async (argv: string[]) =>
      argv.includes("kill") ? { ...response(), termination: "timeout", code: null } : response(),
    );
    await expect(terminateSupervisedCommandScope(identity, () => {})).rejects.toThrow(
      "termination was uncertain",
    );
    expect(host.run.mock.calls.filter(([argv]) => argv.includes("kill"))).toHaveLength(1);
  });

  it("wraps a trusted argv without shell evaluation and rejects unbounded resource policy", () => {
    const argv = buildSupervisedCommandScopeArgv(executionId, identity.limits, [
      "/usr/bin/node",
      "custodian.js",
      "literal;$(text)",
    ]);
    expect(argv.slice(-4)).toEqual(["--", "/usr/bin/node", "custodian.js", "literal;$(text)"]);
    expect(argv).toContain("--property=MemorySwapMax=0");
    expect(() =>
      buildSupervisedCommandScopeArgv("../other.scope", identity.limits, ["/usr/bin/node"]),
    ).toThrow("UUID");
    expect(() =>
      buildSupervisedCommandScopeArgv(executionId, { memoryBytes: Infinity, tasks: 32 }, [
        "/usr/bin/node",
      ]),
    ).toThrow("limits");
    expect(() =>
      buildSupervisedCommandScopeArgv(executionId, { memoryBytes: 67108864, tasks: 0 }, [
        "/usr/bin/node",
      ]),
    ).toThrow("limits");
  });
});
