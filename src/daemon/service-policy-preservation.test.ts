import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import "./service-definition-backup.mocks.test-support.js";
import { expect, it, vi } from "vitest";
import * as terminalNote from "../../packages/terminal-core/src/note.js";
import { installDoctorGatewayService } from "../commands/doctor-gateway-installation.js";
import * as exec from "../process/exec.js";
import { escapeXml } from "../shared/xml.js";
import { resolveGatewayServiceDescription } from "./constants.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import { resolveGatewaySupervisorLogPaths } from "./restart-logs.js";
import { installScheduledTask } from "./schtasks-install.js";
import { buildHiddenLauncherScript, buildTaskScript } from "./schtasks-layout.js";
import { buildScheduledTaskXml } from "./schtasks-xml.js";
import { restoreGatewayServiceDefinitionBackup } from "./service-definition-backup.js";
import { fixture, native, readRetainedReceipt } from "./service-definition-backup.test-support.js";
import { reconcileGatewayServiceDefinition } from "./service-reconciliation.js";
import { createMockGatewayService } from "./service.test-helpers.js";
import { buildSystemdUnit } from "./systemd-unit.js";

vi.mock("./service-layout.js", async (original) => ({
  ...(await original<typeof import("./service-layout.js")>()),
  gatewayServiceCommandMatchesRoot: async () => true,
}));

it.each(["linux", "darwin", "win32"] as const)(
  "preserves custom native policy while refreshing known defaults: %s",
  async (platform) => {
    const f = await fixture(platform);
    f.command.environment = {
      ...f.command.environment,
      OPENCLAW_SERVICE_VERSION: "2026.8.1",
    };
    const description = resolveGatewayServiceDescription({ env: f.env });
    let original: string;
    if (platform === "linux") {
      original = buildSystemdUnit({ ...f.command, description })
        .replace("TimeoutStartSec=30", "TimeoutStartSec=45")
        .replace("TimeoutStopSec=330", "TimeoutStopSec=30");
    } else if (platform === "darwin") {
      vi.spyOn(exec, "runExec").mockImplementation((file, args, options) => {
        if (file !== "/usr/bin/plutil" || typeof options !== "object" || !options.input) {
          throw new Error(`Unexpected fixture subprocess: ${file}`);
        }
        return Promise.resolve(decodeLaunchAgentPlistFixture(options.input, args[1]));
      });
      const { stdoutPath } = resolveGatewaySupervisorLogPaths(f.env);
      original = buildLaunchAgentPlist({
        ...f.command,
        label: resolveLaunchAgentLabel(f.env),
        comment: description,
        stdoutPath,
        stderrPath: stdoutPath,
      })
        .replace(/(<key>ExitTimeOut<\/key>\s*<integer>)\d+/u, "$1600")
        .replace(/(<key>ThrottleInterval<\/key>\s*<integer>)10/u, "$11");
    } else {
      original = buildTaskScript({ ...f.command, description });
      f.setTask(
        buildScheduledTaskXml({
          taskDescription: description,
          launchPath: f.sourcePath,
          taskUser: "operator",
        })
          .replace("<ExecutionTimeLimit>PT0S", "<ExecutionTimeLimit>PT1H")
          .replace("<Count>3</Count>", "<Count>0</Count>"),
      );
    }
    await fs.writeFile(f.sourcePath, original);
    const originalTask = f.task();
    const warnings: string[] = [];

    const receipt = await reconcileGatewayServiceDefinition({
      env: f.env,
      root: "/old",
      command: f.command,
      expectedCommand: {
        programArguments: ["/usr/bin/node", "/new/index.js", "gateway"],
        environment: {
          OPENCLAW_STATE_DIR: f.env.OPENCLAW_STATE_DIR,
          OPERATOR_SETTING: "new-value",
        },
      },
      install: f.install,
      warn: (message) => warnings.push(message),
    });

    const rewritten = await fs.readFile(f.sourcePath, "utf8");
    const key =
      platform === "linux"
        ? "Service.TimeoutStartSec"
        : platform === "darwin"
          ? "ExitTimeOut"
          : "Settings.ExecutionTimeLimit";
    expect(
      warnings.some((message) => message.includes(key) && message.includes("not changed")),
    ).toBe(true);
    expect(rewritten).toContain("/new/index.js");
    if (platform === "linux") {
      expect(rewritten).toMatch(/^TimeoutStartSec=45$/mu);
      expect(rewritten).toMatch(/^TimeoutStopSec=330$/mu);
    } else if (platform === "darwin") {
      expect(rewritten).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>600<\/integer>/u);
      expect(rewritten).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/u);
    } else {
      expect(f.task()).toContain("<ExecutionTimeLimit>PT1H</ExecutionTimeLimit>");
      expect(f.task()).toContain("<Count>3</Count>");
    }

    await restoreGatewayServiceDefinitionBackup({ ...f, receipt });
    expect(await fs.readFile(f.sourcePath)).toEqual(Buffer.from(original));
    if (platform === "win32") {
      expect(f.task()).toBe(originalTask);
    }
  },
);

it.each(["migrated", "registration-rejected"])(
  "keeps Doctor's legacy Windows task repair recoverable: %s",
  async (outcome) => {
    const f = await fixture("win32");
    const hiddenPath = f.sourcePath.replace(/\.cmd$/u, ".vbs");
    const script = buildTaskScript(f.command).replace(
      'if not defined OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER set "OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER=cmd"\r\n',
      "",
    );
    const launcher = buildHiddenLauncherScript({ scriptPath: f.sourcePath });
    await fs.writeFile(f.sourcePath, script);
    await fs.writeFile(hiddenPath, launcher);
    f.setTask(
      buildScheduledTaskXml({
        taskDescription: "OpenClaw Gateway",
        taskUser: "operator",
        launchPath: hiddenPath,
        interactive: true,
      }).replace(
        /<Command>[^<]*<\/Command>/u,
        `<Command>wscript.exe</Command><Arguments>&quot;${escapeXml(hiddenPath)}&quot;</Arguments>`,
      ),
    );
    const oldXml = f.task();
    const directory = path.dirname(f.sourcePath);
    const existingBackups = new Set(await fs.readdir(directory));
    const execute = native.task.getMockImplementation()!;
    if (outcome === "registration-rejected") {
      native.task.mockImplementation(async (args: string[]) =>
        args[0] === "/Create"
          ? { code: 1, stdout: "", stderr: "Registration rejected" }
          : execute(args),
      );
    }
    const warnings: string[] = [];
    vi.spyOn(terminalNote, "note").mockImplementation((message) => {
      warnings.push(String(message));
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await installDoctorGatewayService({
      service: createMockGatewayService({
        install: async (args) => {
          await installScheduledTask(args);
        },
      }),
      command: f.command,
      maintenance: { assertCurrent: f.assertCurrent, assertReadCurrent: f.assertCurrent },
      repair: { kind: "definition", root: "/old" },
      args: { ...f.command, env: f.env, stdout: new PassThrough() },
      runtime,
    });

    const newBackups = (await fs.readdir(directory))
      .filter((name) => !existingBackups.has(name))
      .map((name) => path.join(directory, name));
    const receipt = await readRetainedReceipt(newBackups);
    expect(receipt.task?.beforeSha256).toEqual(expect.any(String));
    if (outcome === "registration-rejected") {
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Registration rejected"));
      expect(warnings.join("\n")).toContain("previous definition was restored");
    } else {
      expect(runtime.error).not.toHaveBeenCalled();
      expect(f.task()).toContain("<LogonType>S4U</LogonType>");
      expect(f.task()).toContain("<BootTrigger>");
      expect(f.task()).toContain("<LogonTrigger>");
      expect(f.task()).toContain("cmd.exe</Command>");
      expect(f.task()).toContain("/d /s /c &quot;&quot;");
      expect(f.task()).not.toContain("gateway.vbs");
      expect(warnings.join("\n")).toContain("Principals.Principal.LogonType");
      await restoreGatewayServiceDefinitionBackup({ ...f, receipt });
    }
    expect(f.task()).toBe(oldXml);
    expect(await fs.readFile(f.sourcePath, "utf8")).toBe(script);
    expect(await fs.readFile(hiddenPath, "utf8")).toBe(launcher);
  },
);
