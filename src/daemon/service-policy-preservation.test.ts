import fs from "node:fs/promises";
import "./service-definition-backup.mocks.test-support.js";
import { expect, it, vi } from "vitest";
import * as exec from "../process/exec.js";
import { resolveGatewayServiceDescription } from "./constants.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import { resolveGatewaySupervisorLogPaths } from "./restart-logs.js";
import { buildTaskScript } from "./schtasks-layout.js";
import { buildScheduledTaskXml } from "./schtasks-xml.js";
import { restoreGatewayServiceDefinitionBackup } from "./service-definition-backup.js";
import { fixture } from "./service-definition-backup.test-support.js";
import { reconcileGatewayServiceDefinition } from "./service-reconciliation.js";
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
      const { stdoutPath } = resolveGatewaySupervisorLogPaths(f.env, { platform });
      original = buildLaunchAgentPlist({
        ...f.command,
        label: resolveLaunchAgentLabel(f.env),
        comment: description,
        stdoutPath,
        stderrPath: stdoutPath,
      })
        .replace(/(<key>ExitTimeOut<\/key>\s*<integer>)20/u, "$1600")
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
