import "./service-definition-backup.mocks.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runCliProcessChild,
  waitForCliProcessStderrMarker,
} from "../cli/cli-process-child.test-helpers.js";
import { omitExportedTaskDefaults } from "./schtasks-export-defaults.test-support.js";
import { readScheduledTaskCommand } from "./schtasks-layout.js";
import { restoreGatewayServiceDefinitionBackup } from "./service-definition-backup.js";
import { fixture, native, readRetainedReceipt } from "./service-definition-backup.test-support.js";
import { publishServiceFile } from "./service-stage.js";

async function nativeOmittedEnabledRefresh() {
  const f = await fixture("win32");
  const execute = native.task.getMockImplementation()!;
  native.task.mockImplementation(async (args: string[]) => {
    const result = await execute(args);
    if (args[0] === "/Create") {
      // windows-2025 run 35551610834 exports the true default without a field,
      // then adds a separate Enabled=false line when the operator disables it.
      f.setTask(
        omitExportedTaskDefaults(f.task())
          .replace(
            /(<Settings>)([\s\S]*?)(<\/Settings>)/u,
            (_match, open, body, close) =>
              `${open}${body.replace(/[\t \r\n]*<Enabled>true<\/Enabled>/u, "")}${close}`,
          )
          .replace(/\r?\n/gu, "\r\r\n"),
      );
    }
    return result;
  });
  await f.install();
  const receipt = await readRetainedReceipt(f.capture.backupPaths);
  await f.capture.finish();
  native.task.mockImplementation(execute);
  const disabled = f
    .task()
    .replace(
      "</StopIfGoingOnBatteries>",
      "</StopIfGoingOnBatteries>\r\r\n    <Enabled>false</Enabled>",
    );
  return { ...f, receipt, disabled };
}

describe("service definition backup receipts", () => {
  it("restores a serialized native receipt after omitted Enabled becomes explicit false", async () => {
    const f = await nativeOmittedEnabledRefresh();
    expect(f.disabled).not.toBe(f.task());
    f.setTask(f.disabled);
    await restoreGatewayServiceDefinitionBackup({ ...f, receipt: f.receipt });
    expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
    expect(f.task()).toBe(
      f.originalTask.replace(
        /(<Settings>[\s\S]*?)<Enabled>true<\/Enabled>/u,
        "$1<Enabled>false</Enabled>",
      ),
    );
  });

  it.each(["duplicate", "attribute", "nested", "priority", "identity", "unknown"])(
    "refuses a %s change alongside native Enabled omission",
    async (edit) => {
      const f = await nativeOmittedEnabledRefresh();
      const enabled = "<Enabled>false</Enabled>";
      const changed =
        edit === "duplicate"
          ? f.disabled.replace(enabled, enabled + enabled)
          : edit === "attribute"
            ? f.disabled.replace(enabled, '<Enabled custom="true">false</Enabled>')
            : edit === "nested"
              ? f.task().replace("<IdleSettings>", `<IdleSettings>${enabled}`)
              : edit === "priority"
                ? f.disabled.replace("<Settings>", "<Settings><Priority>4</Priority>")
                : edit === "identity"
                  ? f.disabled.replace("<UserId>operator</UserId>", "<UserId>another</UserId>")
                  : f.disabled.replace(
                      "<Settings>",
                      "<Settings><CustomSetting>true</CustomSetting>",
                    );
      f.setTask(changed);
      await expect(
        restoreGatewayServiceDefinitionBackup({ ...f, receipt: f.receipt }),
      ).rejects.toThrow("Scheduled Task changed");
      expect(f.task()).toBe(changed);
      expect(native.task.mock.calls.filter(([args]) => args[0] === "/Create")).toHaveLength(1);
    },
  );

  it.each(["linux", "win32"] as const)(
    "accepts acknowledged original bytes without repeating the %s publication",
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
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (args[1] === f.sourcePath) {
            throw Object.assign(new Error("launcher is open"), { code: "EPERM" });
          }
          return rename(...args);
        });
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
    { platform: "darwin", index: 1 },
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

  it.each(["EPERM"])(
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
    { platform: "darwin", index: 0 },
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
    { platform: "darwin", index: 1 },
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
});
