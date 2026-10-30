import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as groups from "../process/child-process-tree.js";
import type { CommandProcessIdentity } from "../process/command-process-custody.types.js";
import { spawnCommand, withCommandProcessScope } from "../process/exec-spawn.js";
import * as birthIdentity from "../shared/pid-alive.js";
import * as packageRoot from "./openclaw-root.js";
import {
  createUpdateDoctorProcessCustody,
  retainUpdateDoctorProcesses,
} from "./update-doctor-process-custody.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "./update-doctor-result.js";
import * as nativeCustody from "./update-managed-command-custody.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
type NativeCustody = Awaited<ReturnType<typeof nativeCustody.createManagedCommandProcessCustody>>;
type DoctorCustody = Awaited<ReturnType<typeof retainUpdateDoctorProcesses>>;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function doctorFixture() {
  const root = fs.realpathSync(directories.make("doctor-custody-"));
  const privateTmp = path.join(root, "private-tmp");
  fs.mkdirSync(privateTmp, { mode: 0o700 });
  const { databasePath } = installPrivateUpdateHandoffStore(privateTmp);
  const resultPath = path.join(root, "result.json");
  vi.stubEnv(UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV, resultPath);
  vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(root);
  return { root, privateTmp, databasePath, resultPath, receiptPath: `${resultPath}.processes` };
}

function nativeStore(native: NativeCustody) {
  return createManagedHandoffLeaseStore({
    databasePath: native.databasePath,
    existingIdentity: native.databaseIdentity,
    serviceManagerEnv: {},
  });
}

function readReceipt(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function nativeFixture(runId: string, names = [""]) {
  const root = fs.realpathSync(directories.make("doctor-native-"));
  const roots = names.map((name) => path.join(root, name));
  const resultPath = path.join(root, "doctor-result.json");
  const receiptPath = `${resultPath}.processes`;
  const native = await nativeCustody.createManagedCommandProcessCustody({
    roots,
    runId,
    databasePath: path.join(root, "handoffs.sqlite"),
  });
  const parent = (id = runId) =>
    createUpdateDoctorProcessCustody(id, root, resultPath, {
      roots,
      databaseIdentity: native.databaseIdentity,
    });
  return { root, roots, native, receiptPath, parent, store: nativeStore(native) };
}
function runDoctor(custody: DoctorCustody, source: string) {
  const command = () => spawnCommand([process.execPath, "-e", source]);
  return withCommandProcessScope(command, undefined, custody);
}
function liveChild(native: NativeCustody) {
  const argv = [process.execPath, "-e", "process.stdin.resume()"];
  const reservation = native.custody.reserve(argv);
  const child = spawn(argv[0]!, argv.slice(1), {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  return { child, reservation, closed: once(child, "close") };
}

describe.skipIf(process.platform === "win32")("Unix command custody", () => {
  it("reserves exited children until their spawning owner settles", async () => {
    const { root, native, store } = await nativeFixture("terminal-before-binding");
    const argv = [process.execPath, "-e", ""];
    const reservation = native.custody.reserve(argv);
    const child = spawnSync(argv[0]!, argv.slice(1));
    try {
      expect(child.status).toBe(0);
      expect(groups.isChildProcessTreeAlive({ pid: child.pid })).toBe(false);
      expect(() => reservation.spawned({ pid: child.pid, startedAt: null })).not.toThrow();
      expect(store.readCommandChildren([root])).toMatchObject([
        { action: { custody: "reserved" } },
      ]);
    } finally {
      reservation.settled();
      native.releaseAnchors();
    }
    expect(store.readCommandChildren([root])).toEqual([]);
  });

  it.each([true, false])(
    "binds a live child only with captured birth identity (captured: %s)",
    async (captured) => {
      const { root, native, store } = await nativeFixture("captured-before-binding");
      const { child, reservation, closed } = liveChild(native);
      await once(child, "spawn");
      const pid = child.pid!;
      const startedAt = birthIdentity.getProcessInstanceStartTime(pid);
      expect(startedAt).not.toBeNull();
      const readBirth = birthIdentity.getFileLockProcessStartTime;
      const probe = vi
        .spyOn(birthIdentity, "getFileLockProcessStartTime")
        .mockImplementation((queried, ...args) =>
          queried === pid ? null : readBirth(queried, ...args),
        );
      try {
        const bind = () => reservation.spawned({ pid, startedAt: captured ? startedAt : null });
        if (captured) {
          expect(bind).not.toThrow();
          expect(store.readCommandChildren([root])).toMatchObject([
            { executor: { pid }, action: { custody: "bound" } },
          ]);
        } else {
          expect(bind).toThrow("managed handoff process start identity is unavailable");
          expect(store.readCommandChildren([root])).toMatchObject([
            { action: { custody: "reserved" } },
          ]);
        }
      } finally {
        probe.mockRestore();
        child.stdin!.end();
        await closed;
        reservation.settled();
        native.releaseAnchors();
      }
      expect(store.readCommandChildren([root])).toEqual([]);
    },
  );

  it.each([false, true])(
    "retains failed-bind child identity (settlement fails: %s)",
    async (settlementFails) => {
      const { root, databasePath, receiptPath } = doctorFixture();
      const create = nativeCustody.createManagedCommandProcessCustody;
      let identity: CommandProcessIdentity | undefined;
      let releaseReservation: (() => void) | undefined;
      vi.spyOn(nativeCustody, "createManagedCommandProcessCustody").mockImplementation(
        async (options) => {
          const native = await create(options);
          const reserve = native.custody.reserve.bind(native.custody);
          native.custody.reserve = (argv) => {
            const reservation = reserve(argv);
            releaseReservation = () => reservation.settled();
            return {
              spawned(childIdentity) {
                identity = childIdentity;
                throw new Error("Native command binding failed");
              },
              settled() {
                if (settlementFails) {
                  throw new Error("Native command settlement failed");
                }
                reservation.settled();
              },
            };
          };
          return native;
        },
      );
      const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: {} });
      using custody = await retainUpdateDoctorProcesses();
      await expect(runDoctor(custody, "process.stdin.resume()")).rejects.toMatchObject({
        code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN",
      });
      try {
        expect(identity).toMatchObject({ pid: expect.any(Number) });
        expect(groups.isChildProcessTreeAlive(identity!)).toBe(false);
        const receipt = readReceipt(receiptPath);
        expect(receipt.slots).toEqual(settlementFails ? [{ id: 1, identity }] : []);
        expect(store.readCommandChildren([root])).toHaveLength(settlementFails ? 1 : 0);
      } finally {
        if (settlementFails) {
          releaseReservation?.();
        }
      }
    },
  );

  it.each([
    ["legacy updater without a run ID", undefined, true, false],
    ["current updater", "current-update-run", true, false],
    ["invalid current run ID", "x".repeat(4097), false, false],
    ["recovered IPC publication", "current-update-run", true, true],
  ] as const)(
    "admits Doctor commands with %s only with valid custody",
    async (_name, runId, admitted, publicationFault) => {
      const { root, databasePath, receiptPath } = doctorFixture();
      const effect = path.join(root, "command-effect");
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", runId);
      const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: {} });
      {
        using custody = await retainUpdateDoctorProcesses();
        expect(custody).toBeDefined();
        const dispatch = () =>
          runDoctor(
            custody,
            "require('node:fs').writeFileSync(" + JSON.stringify(effect) + ", 'completed')",
          );
        if (publicationFault) {
          const publicationError = Object.assign(new Error("Doctor receipt publication failed"), {
            code: "EIO",
          });
          const publication = vi.spyOn(fs, "renameSync").mockImplementationOnce((from, to) => {
            expect([from, to]).toEqual([`${receiptPath}.pending`, receiptPath]);
            throw publicationError;
          });
          await expect(dispatch()).rejects.toBe(publicationError);
          publication.mockRestore();
          expect(fs.existsSync(effect)).toBe(false);
          expect(store.readCommandChildren([root])).toEqual([]);
        }
        if (admitted) {
          await dispatch();
          expect(fs.readFileSync(effect, "utf8")).toBe("completed");
        } else {
          await expect(dispatch()).rejects.toThrow("managed handoff admission is invalid");
          expect(fs.existsSync(effect)).toBe(false);
        }
        expect(readReceipt(receiptPath)).toMatchObject({ slots: [] });
        expect(store.readCommandChildren([root])).toEqual([]);
      }
      expect(fs.existsSync(receiptPath)).toBe(false);
      expect(store.read(root).kind).toBe("absent");
    },
  );
});

it.each(["unavailable root", "missing bound database", "inaccessible command storage"] as const)(
  "permits no-child Doctor work with %s while refusing writer admission",
  async (failure) => {
    const { root, privateTmp, databasePath, receiptPath } = doctorFixture();
    const effect = path.join(root, "writer-effect");
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(packageRoot.resolveOpenClawPackageRoot).mockResolvedValue(
      failure === "unavailable root" ? null : root,
    );
    if (failure === "missing bound database") {
      fs.writeFileSync(
        receiptPath,
        JSON.stringify({
          nonce: "parent-custody",
          runId: "run",
          pid: 0,
          slots: [],
          namespace: {
            roots: [root],
            databaseIdentity: { databasePath, databaseIdentity: "1:2", parentIdentity: "1:3" },
          },
        }),
      );
    }
    const storageFailure = Object.assign(new Error("Command storage is inaccessible"), {
      code: "EACCES",
    });
    if (failure === "inaccessible command storage") {
      const mkdir = fs.mkdirSync;
      vi.spyOn(fs, "mkdirSync").mockImplementation((...args) => {
        if (String(args[0]) === privateTmp) {
          throw storageFailure;
        }
        return mkdir(...args);
      });
    }
    {
      using custody = await retainUpdateDoctorProcesses();
      expect(custody).toBeDefined();
      await expect(
        withCommandProcessScope(async () => "diagnostics completed", undefined, custody),
      ).resolves.toBe("diagnostics completed");
      const dispatch = runDoctor(
        custody,
        "require('node:fs').writeFileSync(" + JSON.stringify(effect) + ", 'written')",
      );
      if (failure === "unavailable root") {
        await expect(dispatch).rejects.toThrow(
          "Doctor process custody requires its installation root",
        );
      } else if (failure === "missing bound database") {
        await expect(dispatch).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(dispatch).rejects.toBe(storageFailure);
      }
      expect(fs.existsSync(effect)).toBe(false);
      expect(readReceipt(receiptPath)).toMatchObject({ slots: [] });
    }
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(fs.existsSync(receiptPath)).toBe(failure === "missing bound database");
  },
);

describe.skipIf(process.platform === "win32")("Unix custody reconciliation", () => {
  it.each(["reservation-before-ipc", "retired-before-ipc"])(
    "reconciles %s against durable custody, not the IPC namespace",
    async (cut) => {
      const ctx = await nativeFixture("run", ["original", "candidate"]);
      const parent = await ctx.parent();
      const receipt: Record<string, unknown> = readReceipt(ctx.receiptPath);
      const nonce = receipt.nonce;
      if (typeof nonce !== "string") {
        throw new Error("Doctor custody nonce is unavailable");
      }
      fs.writeFileSync(
        ctx.receiptPath,
        JSON.stringify({
          ...receipt,
          pid: process.pid,
          namespace: {
            roots: [path.join(ctx.root, "unrelated")],
            databaseIdentity: ctx.native.databaseIdentity,
          },
          slots:
            cut === "retired-before-ipc" ? [{ id: 1, identity: { pid: 4242, startedAt: 1 } }] : [],
        }),
      );
      const doctorNative = await nativeCustody.createManagedCommandProcessCustody({
        roots: ctx.roots,
        runId: "run",
        databaseIdentity: ctx.native.databaseIdentity,
        anchorOwner: `doctor:${nonce}`,
      });
      const reservation =
        cut === "reservation-before-ipc"
          ? doctorNative.custody.reserve([process.execPath])
          : undefined;
      vi.spyOn(groups, "isChildProcessTreeAlive").mockReturnValue(false);
      try {
        const settlement = await parent.settle({
          pid: process.pid,
          code: 124,
          cleanup: "forced",
          termination: "timeout",
        });
        expect(settlement).toMatchObject({ exitCode: reservation ? 1 : 0 });
        if (reservation) {
          expect(settlement?.failureFacts).toContainEqual(
            expect.objectContaining({
              code: "doctor-processes-unsettled",
              message: expect.stringContaining("reservation"),
            }),
          );
          expect(ctx.store.readCommandChildren(ctx.roots)).toHaveLength(ctx.roots.length);
          for (const installRoot of ctx.roots) {
            expect(ctx.store.read(installRoot)).toMatchObject({
              kind: "current",
              lease: { owner: `doctor:${nonce}` },
            });
          }
        } else {
          expect(ctx.store.readCommandChildren(ctx.roots)).toEqual([]);
        }
        parent.close();
        expect(fs.existsSync(ctx.receiptPath)).toBe(Boolean(reservation));
      } finally {
        reservation?.settled();
        doctorNative.releaseAnchors();
      }
    },
  );

  it("settles an exited Doctor without retiring foreign live custody", async () => {
    const ctx = await nativeFixture("doctor-b", ["", "candidate"]);
    const parent = await ctx.parent("doctor-a");
    const doctor = spawnSync(process.execPath, [
      "-e",
      "const fs = require('node:fs'); const file = process.argv[1]; " +
        "const receipt = JSON.parse(fs.readFileSync(file, 'utf8')); " +
        "receipt.pid = process.pid; fs.writeFileSync(file, JSON.stringify(receipt));",
      ctx.receiptPath,
    ]);
    expect([doctor.error, doctor.status]).toEqual([undefined, 0]);
    expect(readReceipt(ctx.receiptPath)).toMatchObject({ pid: doctor.pid, slots: [] });
    const { child: writer, reservation, closed } = liveChild(ctx.native);
    try {
      await once(writer, "spawn");
      if (!writer.pid) {
        throw new Error("Missing peer command PID");
      }
      reservation.spawned({ pid: writer.pid, startedAt: null });
      const claims = ctx.store.readCommandChildren(ctx.roots);
      expect(claims).toHaveLength(ctx.roots.length);
      const settlement = await parent.settle({
        pid: doctor.pid,
        code: 0,
        cleanup: "normal",
        termination: "exit",
      });
      expect(settlement, settlement?.stderrTail ?? undefined).toMatchObject({
        exitCode: 0,
        diagnostics: [expect.stringContaining(`foreign custody, owned by Doctor ${process.pid}`)],
      });
      expect(settlement?.advisory).toBeUndefined();
      parent.close();
      expect(fs.existsSync(ctx.receiptPath)).toBe(false);
      expect(groups.isChildProcessTreeAlive({ pid: writer.pid })).toBe(true);
      expect(ctx.store.readCommandChildren(ctx.roots)).toEqual(claims);
      for (const installRoot of ctx.roots) {
        expect(ctx.store.acquire(installRoot, "replacement", { kind: "update" }).kind).toBe("busy");
      }
    } finally {
      writer.stdin?.end();
      await closed;
      reservation.settled();
      ctx.native.releaseAnchors();
      parent.close();
    }
    for (const installRoot of ctx.roots) {
      const replacement = ctx.store.acquire(installRoot, "replacement", { kind: "update" });
      expect(replacement.kind).toBe("acquired");
      if (replacement.kind === "acquired") {
        expect(ctx.store.release(replacement.lease)).toBe(true);
      }
    }
  });
});

// name, interrupted, delegated, inputReleased, running, blocked
it.each([
  ["normal completion", false, false, undefined, false, false],
  ["unknown interruption", true, false, undefined, false, true],
  ["withheld private grant", true, true, false, false, false],
  ["released private grant", true, true, true, false, true],
  ["standalone withheld input", true, false, false, false, true],
  ["running private child", true, true, false, true, true],
] as const)(
  "preserves Windows Doctor writer custody for %s",
  async (_name, interrupted, delegated, inputReleased, running, blocked) => {
    const root = directories.make("doctor-windows-custody-");
    const resultPath = path.join(root, "result.json");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv(UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV, resultPath);
    vi.spyOn(groups, "isChildProcessTreeAlive").mockReturnValue(running);
    vi.spyOn(nativeCustody, "createManagedCommandProcessCustody").mockImplementation(() => {
      throw new Error("Windows command groups have no extinction receipt");
    });
    const parent = await createUpdateDoctorProcessCustody(
      "run",
      root,
      resultPath,
      undefined,
      delegated ? "delegated-doctor" : undefined,
    );
    expect(await retainUpdateDoctorProcesses()).toBeUndefined();
    const settlement = await parent.settle({
      pid: 4242,
      code: interrupted ? null : 0,
      cleanup: interrupted ? "forced" : "normal",
      termination: interrupted ? "timeout" : "exit",
      inputReleased,
    });
    if (blocked) {
      expect(settlement).toMatchObject({
        exitCode: 1,
        failureFacts: [
          {
            code: "doctor-processes-unsettled",
            message: expect.stringContaining("4242"),
          },
        ],
      });
    } else {
      expect(settlement).toBeUndefined();
    }
    parent.close();
    expect(fs.existsSync(`${resultPath}.processes`)).toBe(blocked);
  },
);
