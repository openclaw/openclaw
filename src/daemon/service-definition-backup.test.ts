import "./service-definition-backup.mocks.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  runCliProcessChild,
  waitForCliProcessStderrMarker,
} from "../cli/cli-process-child.test-helpers.js";
import { restartLaunchAgent } from "./launchd-lifecycle.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import { readScheduledTaskCommand, resolveStartupEntryPaths } from "./schtasks-layout.js";
import { restoreGatewayServiceDefinitionBackup } from "./service-definition-backup.js";
import { fixture, native, readRetainedReceipt } from "./service-definition-backup.test-support.js";
import {
  GatewayServiceDefinitionBackupReceiptSchema,
  publishServiceFile,
  type GatewayServiceDefinitionBackupReceipt,
} from "./service-stage.js";
import { stageSystemdService } from "./systemd-install.js";
import { restartSystemdService } from "./systemd-lifecycle.js";
import { parseSystemdExecStart } from "./systemd-unit.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const readFiles = (f: Fixture) => Promise.all(f.files.map((file) => fs.readFile(file)));
const retainedReceipt = (f: Fixture) => readRetainedReceipt(f.capture.backupPaths);
const taskCalls = (...verbs: string[]) =>
  native.task.mock.calls.filter(([args]) => verbs.includes(args[0]));
async function restore(f: Fixture, receipt?: GatewayServiceDefinitionBackupReceipt) {
  await restoreGatewayServiceDefinitionBackup({
    ...f,
    receipt: receipt ?? (await retainedReceipt(f)),
  });
}
function denyRename(target: string) {
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (destination === target) {
      throw Object.assign(new Error("launcher is open: EPERM"), { code: "EPERM" });
    }
    return rename(source, destination);
  });
}
function afterRename(effect: (destination: Parameters<typeof fs.rename>[1]) => Promise<void>) {
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    await rename(source, destination);
    await effect(destination);
  });
  return rename;
}
function afterTask(effect: (args: string[]) => void) {
  const execute = native.task.getMockImplementation()!;
  native.task.mockImplementation(async (args: string[]) => {
    const result = await execute(args);
    effect(args);
    return result;
  });
}
const disableTask = (xml: string) =>
  xml.replace(/(<Settings>[\s\S]*?)<Enabled>true<\/Enabled>/u, "$1<Enabled>false</Enabled>");
const normalizePrincipal = (xml: string) =>
  xml
    .replaceAll("<UserId>operator</UserId>", "<UserId>S-1-5-21-1-2-3-1001</UserId>")
    .replace("<RunLevel>LeastPrivilege</RunLevel>", "");
function editTaskElement(f: Fixture, element: string, value: string) {
  f.setTask(
    f
      .task()
      .replace(
        new RegExp(`<${element}>[^<]*</${element}>`, "u"),
        `<${element}>${value}</${element}>`,
      ),
  );
}

describe("service definition backup receipts", () => {
  it.each(["linux", "win32"] as const)(
    "accepts acknowledged %s originals without republishing",
    async (platform) => {
      const f = await fixture(platform);
      if (platform === "win32") {
        await f.install();
      }
      await publishServiceFile({
        filePath: f.sourcePath,
        contents: f.original,
        mode: 0o600,
        definitionTransaction: f.capture.hooks,
      });
      if (platform === "win32") {
        denyRename(f.sourcePath);
      }
      native.identity.mockClear();
      await expect(f.capture.compensate()).resolves.toBe(true);
      expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
      if (platform === "linux") {
        expect(
          native.identity.mock.calls.filter(([, args]) => args.includes("daemon-reload")),
        ).toHaveLength(1);
      } else {
        expect(f.task()).toBe(f.originalTask);
      }
    },
  );

  it.each(["candidate", "original"])(
    "rejects %s-byte replacement before acknowledgement",
    async (bytes) => {
      const f = await fixture("win32");
      const replacement = `${f.sourcePath}.operator`;
      // Allocate before publication can free the original inode for reuse.
      await fs.writeFile(replacement, f.original, { mode: 0o600 });
      const originalFile = await fs.stat(f.sourcePath);
      const operatorFile = await fs.stat(replacement);
      expect([operatorFile.dev, operatorFile.ino]).not.toEqual([
        originalFile.dev,
        originalFile.ino,
      ]);
      const acknowledge = f.capture.hooks.fileWritten;
      vi.spyOn(f.capture.hooks, "fileWritten").mockImplementationOnce(async (source, contents) => {
        if (bytes === "candidate") {
          await fs.writeFile(replacement, await fs.readFile(source));
        }
        await fs.rename(replacement, source);
        await acknowledge(source, contents);
      });
      await expect(f.install()).rejects.toThrow("Could not verify service publication");
      const edited = await fs.readFile(f.sourcePath);
      await expect(f.capture.compensate()).rejects.toThrow("Service definition changed");
      expect(await fs.readFile(f.sourcePath)).toEqual(edited);
    },
  );

  it.each([
    ["win32", 0],
    ["darwin", 1],
  ] as const)("preserves %s artifact %i edits during checkpointing", async (platform, index) => {
    const f = await fixture(platform, true);
    const target = f.files[index]!;
    const checkpoint = f.capture.backupPaths.find((file) => file.endsWith(".receipt.bak"));
    const edited = Buffer.from("operator edit during checkpoint\n");
    let injected = false;
    afterRename(async (destination) => {
      if (!injected && destination === checkpoint) {
        const receipt = await retainedReceipt(f);
        if (receipt.files.some((file) => file.sourcePath === target && file.prepared)) {
          injected = true;
          await fs.writeFile(target, edited);
        }
      }
    });
    await expect(f.install()).rejects.toThrow("Service definition changed");
    expect(injected).toBe(true);
    expect(await fs.readFile(target)).toEqual(edited);
    await expect(f.capture.compensate()).rejects.toThrow("Service definition changed");
    expect(await fs.readFile(target)).toEqual(edited);
  });

  it("preserves the Windows launcher after EPERM", async () => {
    const f = await fixture("win32", true);
    const before = await readFiles(f);
    denyRename(f.sourcePath);
    await expect(f.install()).rejects.toThrow("EPERM");
    await f.capture.compensate();
    expect(await readFiles(f)).toEqual(before);
    expect(taskCalls("/Create", "/Run")).toHaveLength(0);
  });

  it.each(["same bytes", "different bytes"])(
    "rejects later %s as a prepared publication",
    async (replacement) => {
      const f = await fixture("win32");
      let interrupted = false;
      const rename = afterRename(async (destination) => {
        if (!interrupted && destination === f.sourcePath) {
          interrupted = true;
          const edited = `${f.sourcePath}.operator`;
          await fs.writeFile(
            edited,
            replacement === "same bytes" ? await fs.readFile(f.sourcePath) : "operator edit",
            { mode: 0o600 },
          );
          await rename(edited, f.sourcePath);
          throw new Error("interrupted after operator replacement");
        }
      });
      await expect(f.install()).rejects.toThrow("interrupted after operator replacement");
      const bytes = await fs.readFile(f.sourcePath);
      await expect(restore(f)).rejects.toThrow("Service definition changed");
      expect(await fs.readFile(f.sourcePath)).toEqual(bytes);
    },
  );

  it.skipIf(process.platform === "win32").each(["partial-write", "before-rename"])(
    "retains launcher and receipt after writer crash: %s",
    async (fault) => {
      const f = await fixture("win32");
      const checkpoint = f.capture.backupPaths.find((file) => file.endsWith(".receipt.bak"));
      const originalCommand = await readScheduledTaskCommand(f.env);
      const script = `
        import fs from "node:fs/promises";
        import path from "node:path";
        import { stageScheduledTask } from ${JSON.stringify(new URL("./schtasks-install.ts", import.meta.url).href)};
        const target = ${JSON.stringify(f.sourcePath)};
        const write = fs.writeFile.bind(fs);
        const open = fs.open.bind(fs);
        const rename = fs.rename.bind(fs);
        const pause = async () => {
          setInterval(() => {}, 1000);
          process.stderr.write("PUBLICATION_WRITE_OPEN\\n");
          await new Promise(() => {});
        };
        let temporary;
        fs.open = async (...args) => {
          const handle = await open(...args);
          if (typeof args[0] === "string" && path.basename(args[0]).startsWith("." + path.basename(target) + ".openclaw.") && args[1] === "wx") temporary = handle;
          return handle;
        };
        fs.writeFile = async (...args) => {
          if (${JSON.stringify(fault)} === "partial-write" && (args[0] === target || (temporary && args[0] === temporary))) {
            await write(args[0], "", args[2]);
            await pause();
          }
          return write(...args);
        };
        fs.rename = async (...args) => {
          if (${JSON.stringify(fault)} === "before-rename" && args[1] === target) await pause();
          return rename(...args);
        };
        await stageScheduledTask({
          env: ${JSON.stringify(f.env)}, stdout: process.stdout,
          programArguments: [process.execPath, "candidate.js", "gateway"],
        });
      `;
      const result = await runCliProcessChild({
        nodeArgs: ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", script],
        env: {
          PATH: process.env.PATH,
          HOME: f.env.HOME,
          OPENCLAW_STATE_DIR: f.env.OPENCLAW_STATE_DIR,
        },
        interact: async (child) => {
          await waitForCliProcessStderrMarker(child, "PUBLICATION_WRITE_OPEN");
          child.kill("SIGKILL");
        },
      });
      expect(result.signal, result.stderr).toBe("SIGKILL");
      expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
      expect(await readScheduledTaskCommand(f.env)).toEqual(originalCommand);
      expect(checkpoint).toBeDefined();
      await restore(f);
      expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
    },
  );

  it.each(["win32", "darwin", "linux"] as const)(
    "restores a %s checkpoint renamed before acknowledgement",
    async (platform) => {
      const f = await fixture(platform, true);
      const before = await readFiles(f);
      let interrupted = false;
      afterRename(async (destination) => {
        if (!interrupted && destination === f.sourcePath) {
          interrupted = true;
          throw new Error("interrupted after rename");
        }
      });
      await expect(f.install()).rejects.toThrow("interrupted after rename");
      const checkpoint = f.capture.backupPaths.find((file) => file.endsWith(".receipt.bak"));
      expect(checkpoint).toBeDefined();
      const receipt = await retainedReceipt(f);
      await restore(f, receipt);
      expect(await readFiles(f)).toEqual(before);
    },
  );

  it.each([
    ["win32", 0],
    ["darwin", 1],
  ] as const)("preserves %s artifact %i after ENOSPC", async (platform, index) => {
    const f = await fixture(platform, true);
    const target = f.files[index]!;
    const before = await readFiles(f);
    const open = fs.open.bind(fs);
    const write = fs.writeFile.bind(fs);
    let temporary: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (
        typeof args[0] === "string" &&
        path.basename(args[0]).startsWith(`.${path.basename(target)}.openclaw.`) &&
        args[1] === "wx"
      ) {
        temporary = handle;
      }
      return handle;
    });
    let failed = false;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (!failed && (args[0] === target || (temporary && args[0] === temporary))) {
        failed = true;
        await write(args[0], "partial", args[2]);
        throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
      }
      return write(...args);
    });
    await expect(f.install()).rejects.toThrow("ENOSPC");
    expect(failed).toBe(true);
    expect(await fs.readFile(target)).toEqual(before[index]);
    await f.capture.compensate();
    expect(await readFiles(f)).toEqual(before);
  });

  it.each(["expired", "interrupted-reload"])(
    "reloads systemd before retiring inputs: %s",
    async (mode) => {
      const f = await fixture("linux");
      await stageSystemdService({
        env: f.env,
        stdout: new PassThrough(),
        programArguments: ["/usr/bin/node", "/new/index.js", "gateway"],
        environment: { ...f.command.environment, OPERATOR_SETTING: "candidate" },
        environmentValueSources: { OPERATOR_SETTING: "file" },
        definitionTransaction: f.capture.hooks,
      });
      let receipt = await f.capture.finish();
      let loaded = await fs.readFile(f.sourcePath, "utf8");
      expect(loaded).toContain("EnvironmentFile=");
      const loadedArguments = () => parseSystemdExecStart(/^ExecStart=(.*)$/mu.exec(loaded)![1]!);
      native.command.mockImplementation(async () => {
        if (loaded.includes("EnvironmentFile=")) {
          await fs.access(f.files[1]!);
        }
        return { ...f.command, programArguments: loadedArguments() };
      });
      let started: string[] | undefined;
      let interrupt = mode === "interrupted-reload";
      native.identity.mockImplementation(async (command, args) => {
        expect(command).toBe("systemctl");
        if (args.includes("daemon-reload")) {
          expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
          await fs.access(f.files[1]!);
          if (interrupt) {
            interrupt = false;
            throw new Error("interrupted before daemon-reload");
          }
          loaded = await fs.readFile(f.sourcePath, "utf8");
        } else if (args.includes("restart")) {
          started = loadedArguments();
        } else {
          expect(args).toContain("reset-failed");
        }
        return { code: 0, stdout: "", stderr: "", termination: "exit" };
      });
      if (mode === "expired") {
        native.transport.mockImplementation(async () => {
          f.expire();
          return undefined;
        });
        await expect(restore(f, receipt)).rejects.toThrow("expired authority");
        expect(native.identity).not.toHaveBeenCalled();
        await fs.access(f.files[1]!);
        return;
      }
      await expect(restore(f, receipt)).rejects.toThrow("interrupted before daemon-reload");
      expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
      expect(loaded).toContain("EnvironmentFile=");
      receipt = await retainedReceipt(f);
      await restore(f, receipt);
      expect(loaded).toBe(f.original.toString("utf8"));
      await expect(fs.stat(f.files[1]!)).rejects.toMatchObject({ code: "ENOENT" });
      await restartSystemdService({
        env: f.env,
        stdout: new PassThrough(),
        preserveDefinition: true,
        assertCurrent: f.assertCurrent,
      });
      expect(started).toEqual(f.command.programArguments);
    },
  );

  it.each(["stopped", "absent", "unknown"])(
    "restores launchd disk/cache with a %s job",
    async (job) => {
      const original = Buffer.from(
        buildLaunchAgentPlist({
          label: "ai.openclaw.receipt-fixture",
          programArguments: ["/usr/bin/node", "/old/index.js", "gateway"],
          stdoutPath: "/fixture/gateway.log",
          stderrPath: "/fixture/gateway.log",
        }),
      );
      const f = await fixture("darwin", false, original);
      await f.install();
      const receipt = await f.capture.finish();
      const candidate = await fs.readFile(f.sourcePath);
      let cached: Buffer | null = job === "absent" ? null : candidate;
      let started: Buffer | undefined;
      native.launchctl.mockImplementation(async (args) => {
        expect(args.some((arg) => arg.includes("ai.openclaw.receipt-fixture"))).toBe(true);
        const ok = { code: 0, stdout: "", stderr: "", termination: "exit" as const };
        const missing = { ...ok, code: 113, stderr: "Could not find service" };
        if (args[0] === "print") {
          return job === "unknown"
            ? { ...ok, code: 13, stderr: "Access denied" }
            : cached
              ? { ...ok, stdout: `${args[1]} = {\n\tstate = waiting\n}` }
              : missing;
        }
        if (args[0] === "bootout") {
          expect(await fs.readFile(f.sourcePath)).toEqual(candidate);
          cached = null;
        } else if (args[0] === "bootstrap") {
          cached = await fs.readFile(f.sourcePath);
        } else if (args[0] === "kickstart") {
          if (!cached) {
            return missing;
          }
          started = cached;
        } else {
          expect(args[0]).toBe("enable");
        }
        return ok;
      });
      if (job === "unknown") {
        await expect(restore(f, receipt)).rejects.toThrow("Cached LaunchAgent definition");
        expect(await fs.readFile(f.sourcePath)).toEqual(candidate);
        expect(cached).toEqual(candidate);
        expect(native.launchctl.mock.calls.every(([args]) => args[0] === "print")).toBe(true);
        return;
      }
      await restore(f, receipt);
      expect(cached).toBeNull();
      expect(native.launchctl.mock.calls.some(([args]) => args[0] === "bootout")).toBe(
        job === "stopped",
      );
      expect(
        native.launchctl.mock.calls.some(([args]) =>
          ["enable", "bootstrap", "kickstart"].includes(args[0]!),
        ),
      ).toBe(false);
      await restartLaunchAgent({ env: f.env, stdout: new PassThrough(), preserveDefinition: true });
      expect(started).toEqual(original);
    },
  );
  it.each([false, true])(
    "restores numeric receipts, preserving replacements (%s)",
    async (replaced) => {
      const platform = process.platform === "win32" ? "win32" : "linux";
      const f = await fixture(platform, true);
      const originalFiles = await Promise.all(
        f.files.map(async (file) => ({
          file,
          contents: await fs.readFile(file),
          mode: (await fs.stat(file)).mode & 0o777,
        })),
      );
      await f.install();
      // v2026.10.2 stored numeric dev/ino in every retained service file state.
      const exactReceipt = await f.capture.finish();
      const serialized = JSON.stringify(exactReceipt, (key, value: unknown) => {
        if ((key === "dev" || key === "ino") && typeof value === "string") {
          return Number(BigInt.asUintN(64, BigInt(value)));
        }
        return value;
      });
      const receipt = GatewayServiceDefinitionBackupReceiptSchema.parse(JSON.parse(serialized));
      expect(receipt.files[0]!.after!.ino).toBe(
        Number(BigInt.asUintN(64, BigInt(exactReceipt.files[0]!.after!.ino))),
      );
      const candidate = await fs.readFile(f.sourcePath);
      if (replaced) {
        const replacement = `${f.sourcePath}.operator`;
        await fs.writeFile(replacement, candidate, { mode: 0o600 });
        await fs.rename(replacement, f.sourcePath);
        const replacementIdentity = await fs.stat(f.sourcePath, { bigint: true });
        await expect(restore(f, receipt)).rejects.toThrow("Service definition changed");
        expect(await fs.readFile(f.sourcePath)).toEqual(candidate);
        expect(await fs.stat(f.sourcePath, { bigint: true })).toMatchObject({
          dev: replacementIdentity.dev,
          ino: replacementIdentity.ino,
        });
        return;
      }
      await restore(f, receipt);
      const upgraded = await retainedReceipt(f);
      for (const file of upgraded.files) {
        if (file.after) {
          const current = await fs.stat(file.sourcePath, { bigint: true });
          expect(file.after).toMatchObject({
            dev: current.dev.toString(),
            ino: current.ino.toString(),
          });
        }
      }
      for (const original of originalFiles) {
        expect(await fs.readFile(original.file)).toEqual(original.contents);
        const mode = (await fs.stat(original.file)).mode & 0o777;
        if (platform === "win32") {
          // Windows chmod represents writability; service receipts do not retain DACLs.
          expect(mode).toBe(original.mode);
          expect(mode & 0o200).toBe(0o200);
          await fs.access(original.file, fs.constants.R_OK | fs.constants.W_OK);
        } else {
          expect(mode).toBe(0o600);
        }
      }
    },
  );

  it.each([
    ["win32", false],
    ["darwin", true],
  ] as const)("round-trips %s receipts (ancillary=%s)", async (platform, ancillary) => {
    // Full LaunchAgent permission bits are meaningful only on POSIX hosts.
    const mode = platform === "darwin" && process.platform !== "win32" ? 0o4600 : 0o600;
    const f = await fixture(platform, ancillary, undefined, mode);
    expect(await fs.readFile(f.capture.backupPaths[0]!)).toEqual(f.original);
    expect((await fs.stat(f.capture.backupPaths[0]!)).mode & 0o777).toBe(0o600);
    await f.install();
    const serializedReceipt = JSON.stringify(await f.capture.finish());
    const receipt = GatewayServiceDefinitionBackupReceiptSchema.parse(
      JSON.parse(serializedReceipt),
    );
    expect(await fs.readFile(f.sourcePath)).not.toEqual(f.original);
    if (platform === "win32") {
      expect(f.task()).toContain("<Count>3</Count>");
      f.setTask(disableTask(f.task()));
    }
    await restore(f, receipt);
    expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
    expect((await fs.stat(f.sourcePath)).mode & 0o7777).toBe(mode);
    for (const file of f.files.slice(1)) {
      if (ancillary) {
        expect(await fs.readFile(file, "utf8")).toBe("OPERATOR_SETTING=old-value\n");
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      } else {
        await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
    if (platform === "win32") {
      expect(f.task()).toBe(disableTask(f.originalTask));
    }
  });

  it.each([
    ["linux", false],
    ["darwin", false],
    ["win32", false],
    ["linux", true],
  ] as const)("rejects %s edits before publication (drop-in=%s)", async (platform, dropIn) => {
    const f = await fixture(platform);
    const target = `${f.sourcePath}.d/operator.conf`;
    if (dropIn) {
      await fs.mkdir(path.dirname(target), { mode: 0o700 });
      await fs.writeFile(target, "[Service]\nNice=7\n", { mode: 0o600 });
      f.command.definitionPaths!.push(target);
    } else {
      await fs.appendFile(f.sourcePath, "operator-edit");
    }
    await expect(f.install()).rejects.toThrow(
      dropIn ? "different managed artifacts" : "Service definition changed",
    );
    expect(await fs.readFile(f.sourcePath)).toEqual(
      dropIn ? f.original : Buffer.concat([f.original, Buffer.from("operator-edit")]),
    );
    if (dropIn) {
      expect(await fs.readFile(target, "utf8")).toContain("Nice=7");
    }
  });

  it.each(["later edit", "damaged backup", "expired authority", "foreign path", "task XML edit"])(
    "refuses %s rollback before writing",
    async (fault) => {
      const f = await fixture(fault === "task XML edit" ? "win32" : "darwin", true);
      await f.install();
      const receipt = await f.capture.finish();
      if (fault === "task XML edit") {
        f.setTask(f.task().replace("<Count>3</Count>", "<Count>7</Count>"));
      }
      if (fault === "later edit") {
        await fs.appendFile(f.sourcePath, "operator-edit");
      }
      if (fault === "damaged backup") {
        await fs.writeFile(
          f.capture.backupPaths.findLast((file) => !file.endsWith(".receipt.bak"))!,
          "damaged",
        );
      }
      if (fault === "expired authority") {
        f.expire();
      }
      if (fault === "foreign path") {
        receipt.files[0]!.sourcePath = `${f.sourcePath}.foreign`;
      }
      const before = await readFiles(f);
      const restoration = restore(f, receipt);
      if (fault === "task XML edit") {
        await expect(restoration).rejects.toThrow("Scheduled Task changed");
        expect(f.task()).toContain("<Count>7</Count>");
      } else {
        await expect(restoration).rejects.toThrow();
      }
      expect(await readFiles(f)).toEqual(before);
    },
  );

  it.each(["before-create", "after-create", "normalized", "foreign", "during-restore"])(
    "recovers task receipts after %s interruption",
    async (phase) => {
      const f = await fixture("win32", true);
      if (phase === "during-restore") {
        await f.install();
      }
      const execute = native.task.getMockImplementation()!;
      native.task.mockImplementation(async (args: string[]) => {
        if (args[0] === "/Create" && phase === "before-create") {
          throw new Error("interrupted task publication");
        }
        const result = await execute(args);
        if (args[0] === "/Create") {
          if (phase === "normalized") {
            f.setTask(normalizePrincipal(f.task()));
          } else if (phase === "foreign") {
            f.setTask(f.task().replace("<Count>3</Count>", "<Count>7</Count>"));
          }
          throw new Error("interrupted task publication");
        }
        return result;
      });
      await expect(
        phase === "during-restore" ? restore(f, await f.capture.finish()) : f.install(),
      ).rejects.toThrow("interrupted task publication");
      native.task.mockImplementation(execute);
      const receipt = await retainedReceipt(f);
      if (phase === "foreign") {
        const files = await readFiles(f);
        await expect(restore(f, receipt)).rejects.toThrow("Scheduled Task changed");
        expect(f.task()).toContain("<Count>7</Count>");
        expect(await readFiles(f)).toEqual(files);
        return;
      }
      await restore(f, receipt);
      expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
      expect(f.task()).toBe(f.originalTask);
      expect((await retainedReceipt(f)).task).toMatchObject({
        recoveredPolicy: phase === "before-create" ? "previous" : "prepared",
      });
    },
  );

  it.each([
    ["Settings.RestartOnFailure.Count", "Count", "7"],
    ["Actions.Exec.Command", "Command", "operator-private.cmd"],
    ["RegistrationInfo.Description", "Description", "operator-private"],
    ["verified snapshot", "Count", "7"],
  ] as const)(
    "rejects an intervening native publication edit to %s",
    async (key, element, replacement) => {
      const f = await fixture("win32");
      const snapshot = key === "verified snapshot";
      let published = false;
      let edited = false;
      afterTask((args) => {
        if (args[0] === "/Create") {
          published = true;
        }
        if (
          snapshot
            ? published && !edited && args[0] === "/Query" && args.includes("/XML")
            : args[0] === "/Create"
        ) {
          edited = true;
          editTaskElement(f, element, replacement);
        }
      });
      await expect(f.install()).rejects.toThrow(snapshot ? "Scheduled Task changed" : key);
      if (snapshot) {
        expect(edited).toBe(true);
      }
      const observed = f.task();
      expect(taskCalls("/Change", "/Run")).toHaveLength(0);
      await expect(f.capture.compensate()).rejects.toThrow("Scheduled Task changed");
      expect(f.task()).toBe(observed);
      expect(taskCalls("/Create")).toHaveLength(1);
    },
  );

  it("accepts native SID/default/registration normalization", async () => {
    const f = await fixture("win32");
    afterTask((args) => {
      if (args[0] === "/Create") {
        f.setTask(
          normalizePrincipal(f.task())
            .replace(
              "<Settings>",
              "<Settings><UseUnifiedSchedulingEngine>false</UseUnifiedSchedulingEngine>",
            )
            .replace(
              "<RegistrationInfo>",
              "<RegistrationInfo><Date>2026-09-04T00:00:00Z</Date><Author>operator</Author><URI>\\OpenClaw Gateway</URI>",
            )
            .replace(/(<Settings>[\s\S]*?)<Enabled>true<\/Enabled>/u, "$1<Enabled>false</Enabled>"),
        );
      }
    });
    await f.install();
    expect(f.task()).toContain("<Count>3</Count>");
    expect(f.task()).toContain("<Interval>PT1M</Interval>");
    expect(native.identity).toHaveBeenCalled();
    expect(taskCalls("/Run")).not.toHaveLength(0);
    await expect(f.capture.finish()).resolves.toMatchObject({
      task: { afterPolicySha256: expect.any(String) },
    });
  });

  it("preserves Startup files during receipt-owned install", async () => {
    const f = await fixture("win32");
    f.env.OPENCLAW_GATEWAY_PORT = "19305";
    const startupFiles = resolveStartupEntryPaths(f.env).map((file, index) => ({
      file,
      contents: Buffer.from(`operator login item ${index}\r\n`),
    }));
    for (const { file, contents } of startupFiles) {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, contents, { mode: 0o600 });
    }
    await f.install();
    await expect(f.capture.finish()).resolves.toMatchObject({
      task: { afterPolicySha256: expect.any(String) },
    });
    for (const { file, contents } of startupFiles) {
      expect(await fs.readFile(file)).toEqual(contents);
    }
    expect(taskCalls("/Run")).toHaveLength(1);
    expect(taskCalls("/End")).toHaveLength(0);
  });

  it.each(["registration denied", "policy write failed"])(
    "preserves task and compensates script after %s",
    async (failure) => {
      const f = await fixture("win32");
      const execute = native.task.getMockImplementation()!;
      native.task.mockImplementation(async (args: string[]) =>
        args[0] === "/Create" ||
        (failure === "registration denied" && args[0] === "/Query" && !args.includes("/XML"))
          ? { code: 1, stdout: "", stderr: "ERROR: Access is denied." }
          : execute(args),
      );
      await expect(f.install()).rejects.toThrow(
        failure === "registration denied"
          ? "startup fallback is unsupported"
          : "definition upgrade failed",
      );
      if (failure === "registration denied") {
        expect(f.task()).toBe(f.originalTask);
        for (const file of resolveStartupEntryPaths(f.env)) {
          await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(taskCalls("/Run")).toHaveLength(0);
      } else {
        expect(await fs.readFile(f.sourcePath)).not.toEqual(f.original);
        native.task.mockImplementation(execute);
        await f.capture.compensate();
        expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
        expect(f.task()).toBe(f.originalTask);
        await expect(fs.stat(f.files[1]!)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );
});
