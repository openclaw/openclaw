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
  readServiceFileState,
} from "./service-stage.js";
import { stageSystemdService } from "./systemd-install.js";
import { restartSystemdService } from "./systemd-lifecycle.js";
import { parseSystemdExecStart } from "./systemd-unit.js";

describe("service definition backup receipts", () => {
  it.each(["linux", "darwin", "win32"] as const)(
    "reports unchanged without publishing or activating an untouched %s receipt",
    async (platform) => {
      const f = await fixture(platform);
      const before = await readServiceFileState(f.sourcePath);
      const rename = vi.spyOn(fs, "rename");
      const unlink = vi.spyOn(fs, "unlink");
      native.identity.mockClear();
      native.task.mockClear();
      native.launchctl.mockClear();
      await expect(f.capture.compensate()).resolves.toBe(false);
      expect(await readServiceFileState(f.sourcePath)).toEqual(before);
      expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
      expect(rename).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
      expect(native.identity.mock.calls.some(([, args]) => args.includes("daemon-reload"))).toBe(
        false,
      );
      expect(native.task.mock.calls.some(([args]) => args[0] !== "/Query")).toBe(false);
      expect(native.launchctl.mock.calls.some(([args]) => args[0] !== "print")).toBe(false);
    },
  );

  it("reports restoration for an acknowledged publication with the original bytes", async () => {
    const f = await fixture("linux");
    await publishServiceFile({
      filePath: f.sourcePath,
      contents: f.original,
      mode: 0o600,
      definitionTransaction: f.capture.hooks,
    });
    native.identity.mockClear();
    await expect(f.capture.compensate()).resolves.toBe(true);
    expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
    expect(
      native.identity.mock.calls.filter(([, args]) => args.includes("daemon-reload")),
    ).toHaveLength(1);
  });

  it("accepts an acknowledged restoration without replacing an open Windows launcher again", async () => {
    const f = await fixture("win32");
    await f.install();
    await publishServiceFile({
      filePath: f.sourcePath,
      contents: f.original,
      mode: 0o600,
      definitionTransaction: f.capture.hooks,
    });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (args[1] === f.sourcePath) {
        throw Object.assign(new Error("launcher is open"), { code: "EPERM" });
      }
      return rename(...args);
    });
    await f.capture.compensate();
    expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
    expect(f.task()).toBe(f.originalTask);
  });

  it.each(["candidate", "original"])(
    "rejects an operator replacement with %s bytes before acknowledgement",
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
    { platform: "win32", index: 0 },
    { platform: "win32", index: 1 },
    { platform: "darwin", index: 0 },
    { platform: "darwin", index: 1 },
    { platform: "darwin", index: 2 },
  ] as const)(
    "preserves an operator edit to $platform artifact $index during receipt checkpointing",
    async ({ platform, index }) => {
      const f = await fixture(platform, true);
      const target = f.files[index]!;
      const checkpoint = f.capture.backupPaths.find((file) => file.endsWith(".receipt.bak"));
      const edited = Buffer.from("operator edit during checkpoint\n");
      const rename = fs.rename.bind(fs);
      let injected = false;
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        await rename(...args);
        if (!injected && args[1] === checkpoint) {
          const receipt = await readRetainedReceipt(f.capture.backupPaths);
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
    },
  );

  it.each(["EPERM", "EBUSY", "EEXIST"])(
    "preserves a Windows launcher when rename-over is denied with %s",
    async (code) => {
      const f = await fixture("win32", true);
      const before = await Promise.all(f.files.map((file) => fs.readFile(file)));
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        if (args[1] === f.sourcePath) {
          throw Object.assign(new Error(`launcher is open: ${code}`), { code });
        }
        return rename(...args);
      });
      await expect(f.install()).rejects.toThrow(code);
      await f.capture.compensate();
      expect(await Promise.all(f.files.map((file) => fs.readFile(file)))).toEqual(before);
      expect(
        native.task.mock.calls.some(([args]) => args[0] === "/Create" || args[0] === "/Run"),
      ).toBe(false);
    },
  );

  it.each(["same bytes", "different bytes"])(
    "preserves a later replacement with %s instead of adopting it as the prepared publication",
    async (replacement) => {
      const f = await fixture("win32");
      const rename = fs.rename.bind(fs);
      let interrupted = false;
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        await rename(...args);
        if (!interrupted && args[1] === f.sourcePath) {
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
      const receipt = await readRetainedReceipt(f.capture.backupPaths);
      await expect(restoreGatewayServiceDefinitionBackup({ ...f, receipt })).rejects.toThrow(
        "Service definition changed",
      );
      expect(await fs.readFile(f.sourcePath)).toEqual(bytes);
    },
  );

  it.skipIf(process.platform === "win32").each(["partial-write", "before-rename"])(
    "retains the runnable launcher and restorable receipt when its writer crashes at %s",
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
      const receipt = await readRetainedReceipt(f.capture.backupPaths);
      await restoreGatewayServiceDefinitionBackup({ ...f, receipt });
      expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
    },
  );

  it.each([
    { platform: "win32", index: 0 },
    { platform: "win32", index: 1 },
    { platform: "darwin", index: 0 },
    { platform: "darwin", index: 1 },
    { platform: "darwin", index: 2 },
    { platform: "linux", index: 0 },
  ] as const)(
    "restores a checkpoint after $platform artifact $index was renamed before acknowledgement",
    async ({ platform, index }) => {
      const f = await fixture(platform, true);
      const before = await Promise.all(f.files.map((file) => fs.readFile(file)));
      const rename = fs.rename.bind(fs);
      let interrupted = false;
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        await rename(...args);
        if (!interrupted && args[1] === f.files[index]) {
          interrupted = true;
          throw new Error("interrupted after rename");
        }
      });
      await expect(f.install()).rejects.toThrow("interrupted after rename");
      const checkpoint = f.capture.backupPaths.find((file) => file.endsWith(".receipt.bak"));
      expect(checkpoint).toBeDefined();
      const receipt = await readRetainedReceipt(f.capture.backupPaths);
      await restoreGatewayServiceDefinitionBackup({ ...f, receipt });
      expect(await Promise.all(f.files.map((file) => fs.readFile(file)))).toEqual(before);
    },
  );

  it.each([
    { platform: "win32", index: 0 },
    { platform: "win32", index: 1 },
    { platform: "darwin", index: 1 },
    { platform: "darwin", index: 2 },
  ] as const)(
    "keeps live $platform artifact $index intact when publication runs out of space",
    async ({ platform, index }) => {
      const f = await fixture(platform, true);
      const target = f.files[index]!;
      const before = await Promise.all(f.files.map((file) => fs.readFile(file)));
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
      expect(await Promise.all(f.files.map((file) => fs.readFile(file)))).toEqual(before);
    },
  );

  it.each(["normal", "expired", "interrupted-reload"])(
    "reloads the restored systemd definition before retiring its old inputs: %s",
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
        await expect(restoreGatewayServiceDefinitionBackup({ ...f, receipt })).rejects.toThrow(
          "expired authority",
        );
        expect(native.identity).not.toHaveBeenCalled();
        await fs.access(f.files[1]!);
        return;
      }
      if (mode === "interrupted-reload") {
        await expect(restoreGatewayServiceDefinitionBackup({ ...f, receipt })).rejects.toThrow(
          "interrupted before daemon-reload",
        );
        expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
        expect(loaded).toContain("EnvironmentFile=");
        receipt = await readRetainedReceipt(f.capture.backupPaths);
      }
      await restoreGatewayServiceDefinitionBackup({ ...f, receipt });
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
    "restores launchd disk and cached definition with a %s job",
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
              ? { ...ok, stdout: "state = waiting\n" }
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
        await expect(restoreGatewayServiceDefinitionBackup({ ...f, receipt })).rejects.toThrow(
          "Cached LaunchAgent definition",
        );
        expect(await fs.readFile(f.sourcePath)).toEqual(candidate);
        expect(cached).toEqual(candidate);
        expect(native.launchctl.mock.calls.every(([args]) => args[0] === "print")).toBe(true);
        return;
      }
      await restoreGatewayServiceDefinitionBackup({ ...f, receipt });
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
  it.each(["linux", "darwin", "win32"] as const)(
    "backs up before native %s publication and restores exact bytes from a serialized receipt",
    async (platform) => {
      const f = await fixture(platform);
      expect(await fs.readFile(f.capture.backupPaths[0]!)).toEqual(f.original);
      expect((await fs.stat(f.capture.backupPaths[0]!)).mode & 0o777).toBe(0o600);
      await f.install();
      const serializedReceipt = JSON.stringify(await f.capture.finish());
      const receipt = GatewayServiceDefinitionBackupReceiptSchema.parse(
        JSON.parse(serializedReceipt),
      );
      expect(await fs.readFile(f.sourcePath)).not.toEqual(f.original);
      if (platform === "linux") {
        expect(await fs.readFile(f.sourcePath, "utf8")).toContain("KillMode=mixed");
      }
      if (platform === "win32") {
        expect(f.task()).toContain("<Count>3</Count>");
        f.setTask(
          f
            .task()
            .replace(/(<Settings>[\s\S]*?)<Enabled>true<\/Enabled>/u, "$1<Enabled>false</Enabled>"),
        );
      }
      await restoreGatewayServiceDefinitionBackup({ ...f, receipt });
      expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
      expect((await fs.stat(f.sourcePath)).mode & 0o777).toBe(0o600);
      for (const file of f.files.slice(1)) {
        await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (platform === "win32") {
        expect(f.task()).toBe(
          f.originalTask.replace(
            /(<Settings>[\s\S]*?)<Enabled>true<\/Enabled>/u,
            "$1<Enabled>false</Enabled>",
          ),
        );
      }
    },
  );

  it.each(["linux", "darwin"] as const)(
    "restores prior %s ancillary contents and modes",
    async (platform) => {
      const f = await fixture(platform, true);
      await f.install();
      await restoreGatewayServiceDefinitionBackup({ ...f, receipt: await f.capture.finish() });
      for (const file of f.files.slice(1)) {
        expect(await fs.readFile(file, "utf8")).toBe("OPERATOR_SETTING=old-value\n");
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      }
    },
  );

  it.each(["linux", "darwin", "win32"] as const)(
    "rejects edits between capture and the native %s writer",
    async (platform) => {
      const f = await fixture(platform);
      await fs.appendFile(f.sourcePath, "operator-edit");
      await expect(f.install()).rejects.toThrow("Service definition changed");
      expect(await fs.readFile(f.sourcePath)).toEqual(
        Buffer.concat([f.original, Buffer.from("operator-edit")]),
      );
    },
  );

  it.each(["later edit", "damaged backup", "expired authority", "foreign path"])(
    "refuses rollback for %s before changing any file",
    async (fault) => {
      const f = await fixture("darwin", true);
      await f.install();
      const receipt = await f.capture.finish();
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
      const before = await Promise.all(f.files.map((file) => fs.readFile(file)));
      await expect(restoreGatewayServiceDefinitionBackup({ ...f, receipt })).rejects.toThrow();
      expect(await Promise.all(f.files.map((file) => fs.readFile(file)))).toEqual(before);
    },
  );

  it.skipIf(process.platform === "win32")(
    "restores full LaunchAgent permission bits from its receipt",
    async () => {
      const f = await fixture("darwin", false, undefined, 0o4600);
      await f.install();
      await restoreGatewayServiceDefinitionBackup({ ...f, receipt: await f.capture.finish() });
      expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
      expect((await fs.stat(f.sourcePath)).mode & 0o7777).toBe(0o4600);
    },
  );

  it("preserves later Scheduled Task XML edits during rollback", async () => {
    const f = await fixture("win32");
    await f.install();
    const receipt = await f.capture.finish();
    f.setTask(f.task().replace("<Count>3</Count>", "<Count>7</Count>"));
    const script = await fs.readFile(f.sourcePath);
    await expect(restoreGatewayServiceDefinitionBackup({ ...f, receipt })).rejects.toThrow(
      "Scheduled Task changed",
    );
    expect(f.task()).toContain("<Count>7</Count>");
    expect(await fs.readFile(f.sourcePath)).toEqual(script);
  });

  it.each(["before-create", "after-create", "normalized", "foreign", "during-restore"])(
    "recovers the retained task receipt after interruption: %s",
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
            f.setTask(
              f
                .task()
                .replaceAll("<UserId>operator</UserId>", "<UserId>S-1-5-21-1-2-3-1001</UserId>")
                .replace("<RunLevel>LeastPrivilege</RunLevel>", ""),
            );
          } else if (phase === "foreign") {
            f.setTask(f.task().replace("<Count>3</Count>", "<Count>7</Count>"));
          }
          throw new Error("interrupted task publication");
        }
        return result;
      });
      await expect(
        phase === "during-restore"
          ? restoreGatewayServiceDefinitionBackup({ ...f, receipt: await f.capture.finish() })
          : f.install(),
      ).rejects.toThrow("interrupted task publication");
      native.task.mockImplementation(execute);
      const readReceipt = () => readRetainedReceipt(f.capture.backupPaths);
      const receipt = await readReceipt();
      if (phase === "foreign") {
        const files = await Promise.all(f.files.map((file) => fs.readFile(file)));
        await expect(restoreGatewayServiceDefinitionBackup({ ...f, receipt })).rejects.toThrow(
          "Scheduled Task changed",
        );
        expect(f.task()).toContain("<Count>7</Count>");
        expect(await Promise.all(f.files.map((file) => fs.readFile(file)))).toEqual(files);
        return;
      }
      await restoreGatewayServiceDefinitionBackup({ ...f, receipt });
      expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
      expect(f.task()).toBe(f.originalTask);
      expect((await readReceipt()).task).toMatchObject({
        recoveredPolicy: phase === "before-create" ? "previous" : "prepared",
      });
    },
  );

  it.each([
    "Settings.RestartOnFailure.Count",
    "Actions.Exec.Command",
    "RegistrationInfo.Description",
  ])(
    "rejects an intervening native publication edit to %s without absorbing it into rollback",
    async (key) => {
      const f = await fixture("win32");
      const execute = native.task.getMockImplementation()!;
      native.task.mockImplementation(async (args: string[]) => {
        const result = await execute(args);
        if (args[0] === "/Create") {
          f.setTask(
            key === "Settings.RestartOnFailure.Count"
              ? f.task().replace("<Count>3</Count>", "<Count>7</Count>")
              : key === "Actions.Exec.Command"
                ? f
                    .task()
                    .replace(
                      /<Command>[^<]*<\/Command>/u,
                      "<Command>operator-private.cmd</Command>",
                    )
                : f
                    .task()
                    .replace(
                      /<Description>[^<]*<\/Description>/u,
                      "<Description>operator-private</Description>",
                    ),
          );
        }
        return result;
      });
      await expect(f.install()).rejects.toThrow(key);
      const observed = f.task();
      expect(
        native.task.mock.calls.some(([args]) => args[0] === "/Change" || args[0] === "/Run"),
      ).toBe(false);
      await expect(f.capture.compensate()).rejects.toThrow("Scheduled Task changed");
      expect(f.task()).toBe(observed);
      expect(native.task.mock.calls.filter(([args]) => args[0] === "/Create")).toHaveLength(1);
    },
  );

  it("verifies the submitted policy across native SID, default and registration normalization", async () => {
    const f = await fixture("win32");
    const execute = native.task.getMockImplementation()!;
    native.task.mockImplementation(async (args: string[]) => {
      const result = await execute(args);
      if (args[0] === "/Create") {
        f.setTask(
          f
            .task()
            .replaceAll("<UserId>operator</UserId>", "<UserId>S-1-5-21-1-2-3-1001</UserId>")
            .replace("<RunLevel>LeastPrivilege</RunLevel>", "")
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
      return result;
    });
    await f.install();
    expect(f.task()).toContain("<Count>3</Count>");
    expect(f.task()).toContain("<Interval>PT1M</Interval>");
    expect(native.identity).toHaveBeenCalled();
    expect(native.task.mock.calls.some(([args]) => args[0] === "/Run")).toBe(true);
    await expect(f.capture.finish()).resolves.toMatchObject({
      task: { afterPolicySha256: expect.any(String) },
    });
  });

  it("pins the verified XML snapshot and rechecks it before running the task", async () => {
    const f = await fixture("win32");
    const execute = native.task.getMockImplementation()!;
    let published = false;
    let edited = false;
    native.task.mockImplementation(async (args: string[]) => {
      const result = await execute(args);
      if (args[0] === "/Create") {
        published = true;
      } else if (published && !edited && args[0] === "/Query" && args.includes("/XML")) {
        edited = true;
        f.setTask(f.task().replace("<Count>3</Count>", "<Count>7</Count>"));
      }
      return result;
    });
    await expect(f.install()).rejects.toThrow("Scheduled Task changed");
    const observed = f.task();
    expect(edited).toBe(true);
    expect(native.task.mock.calls.some(([args]) => args[0] === "/Run")).toBe(false);
    await expect(f.capture.compensate()).rejects.toThrow("Scheduled Task changed");
    expect(f.task()).toBe(observed);
    expect(native.task.mock.calls.filter(([args]) => args[0] === "/Create")).toHaveLength(1);
  });

  it("preserves coexisting Startup files during a receipt-owned Scheduled Task install", async () => {
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
    expect(native.task.mock.calls.filter(([args]) => args[0] === "/Run")).toHaveLength(1);
    expect(native.task.mock.calls.some(([args]) => args[0] === "/End")).toBe(false);
  });

  it("denies Startup fallback for a receipt-owned install without an executor", async () => {
    const f = await fixture("win32");
    const execute = native.task.getMockImplementation()!;
    native.task.mockImplementation(async (args: string[]) =>
      args[0] === "/Create" || (args[0] === "/Query" && !args.includes("/XML"))
        ? { code: 1, stdout: "", stderr: "ERROR: Access is denied." }
        : execute(args),
    );
    await expect(f.install()).rejects.toThrow("startup fallback is unsupported");
    expect(f.task()).toBe(f.originalTask);
    for (const file of resolveStartupEntryPaths(f.env)) {
      await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(native.task.mock.calls.some(([args]) => args[0] === "/Run")).toBe(false);
  });

  it("does not admit a new systemd drop-in after capture", async () => {
    const f = await fixture("linux");
    const dropIn = `${f.sourcePath}.d/operator.conf`;
    await fs.mkdir(path.dirname(dropIn), { mode: 0o700 });
    await fs.writeFile(dropIn, "[Service]\nNice=7\n", { mode: 0o600 });
    f.command.definitionPaths!.push(dropIn);
    await expect(f.install()).rejects.toThrow("different managed artifacts");
    expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
    expect(await fs.readFile(dropIn, "utf8")).toContain("Nice=7");
  });

  it("compensates proven script publication after a failed Scheduled Task policy write", async () => {
    const f = await fixture("win32");
    const execute = native.task.getMockImplementation()!;
    native.task.mockImplementation(async (args: string[]) =>
      args[0] === "/Create" ? { code: 1, stderr: "access denied", stdout: "" } : execute(args),
    );
    await expect(f.install()).rejects.toThrow("definition upgrade failed");
    expect(await fs.readFile(f.sourcePath)).not.toEqual(f.original);
    native.task.mockImplementation(execute);
    await f.capture.compensate();
    expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
    expect(f.task()).toBe(f.originalTask);
    await expect(fs.stat(f.files[1]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
