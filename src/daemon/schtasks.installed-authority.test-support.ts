import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { hashFile } from "../../scripts/lib/gateway-bench-installed-package.ts";
import {
  createWindowsTaskAutoStartGuard,
  maybeStopManagedServiceBeforeMutableUpdate,
  type PreManagedServiceStop,
} from "../cli/update-cli/update-command-service-maintenance.js";
import { GatewayServiceUpdateOwnershipError } from "../cli/update-cli/update-command-service-plan.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate,
  suspendScheduledTaskAutoStartForUpdate,
} from "./schtasks-control.js";
import { execSchtasks } from "./schtasks-exec.js";
import {
  buildTaskScript,
  encodeWindowsLauncherScript,
  resolveTaskLauncherScriptPath,
} from "./schtasks-layout.js";
import { readScheduledTaskRuntime } from "./schtasks-runtime.js";
import type { InstalledTask } from "./schtasks.installed-diagnostics.test-support.js";
import { entry, packageRoot } from "./schtasks.installed-package.test-support.js";
import {
  disableScheduledTaskXmlForFixture,
  normalizeScheduledTaskXmlEnabledForFixture,
  readRelatedProcessDiagnostics,
  readTaskPrincipal,
  readTaskXml,
} from "./schtasks.integration-observation.test-support.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";

type Admission = Pick<
  PreManagedServiceStop,
  "serviceEnv" | "serviceUpdateVerdict" | "serviceManagerUid"
>;

/** Native autostart control only; the installed lifecycle owns this stopped Task and cleanup. */
export async function inspectInstalledTaskAuthority(params: {
  task: InstalledTask;
  foreignInstallRoot: string;
  canBindLoopbackPort: (port: number) => Promise<boolean>;
  recordProgress: (phase: string, error?: Error) => Promise<void>;
}) {
  const { task, foreignInstallRoot, canBindLoopbackPort, recordProgress } = params;
  assert.notEqual(packageRoot(task.installRoot), packageRoot(foreignInstallRoot));
  const originalXml = await readTaskXml(task.taskName);
  assert.ok(originalXml);
  const originalConfig = await fs.readFile(task.configPath);
  const originalScriptHash = await hashFile(task.scriptPath);
  const root = path.join(task.rootDir, "authority");
  await fs.mkdir(root);
  const restorePath = path.join(root, "restore.xml");
  await fs.writeFile(restorePath, `\uFEFF${originalXml}`, "utf16le");
  const scripts = {
    owned: path.join(root, "owned.cmd"),
    foreign: path.join(root, "foreign.cmd"),
    reassigned: path.join(root, "reassigned.cmd"),
  };
  for (const [kind, scriptPath] of Object.entries(scripts)) {
    await fs.writeFile(
      scriptPath,
      encodeWindowsLauncherScript({
        format: "cmd",
        content: buildTaskScript({
          programArguments: [
            process.execPath,
            kind === "foreign" ? entry(foreignInstallRoot) : task.entry,
            "gateway",
            "--port",
            String(task.gatewayPort),
          ],
          workingDirectory: root,
          environment: { ...task.env, OPENCLAW_TASK_SCRIPT: scriptPath },
        }),
      }),
    );
  }
  const command = /<Command>([^<]+)<\/Command>/u.exec(originalXml);
  assert.ok(command);
  assert.equal(originalXml.match(/<Command>/gu)?.length, 1);
  const definitionPath = path.join(root, "disabled.xml");
  const filePaths = [
    ...new Set([
      task.configPath,
      task.scriptPath,
      resolveTaskLauncherScriptPath(task.env, task.scriptPath),
      ...Object.values(scripts),
    ]),
  ];
  const fileHashes = () => Promise.all(filePaths.map(async (file) => [file, await hashFile(file)]));
  const filesBefore = await fileHashes();
  await recordProgress("authority:definitions-captured");
  const snapshot = async (phase: string) => {
    const principal = readTaskPrincipal(task.taskName);
    const runtime = await readScheduledTaskRuntime(task.env, { requireLoaded: true });
    assert.equal(runtime.status, "stopped");
    assert.equal(runtime.pid, undefined);
    assert.equal(await canBindLoopbackPort(task.gatewayPort), true);
    const processes = readRelatedProcessDiagnostics([root, task.profile]);
    assert.equal(processes.ok, true);
    assert.equal(processes.truncated, false);
    assert.deepEqual(processes.processes, []);
    assert.deepEqual(await fileHashes(), filesBefore);
    const xml = await readTaskXml(task.taskName);
    assert.ok(xml);
    await recordProgress(`authority:snapshot:${phase}`);
    return {
      xml,
      enabled: principal.enabled,
      taskState: principal.taskState,
      lastRunTime: principal.lastRunTime,
      lastTaskResult: principal.lastTaskResult,
      runtime,
      fileHashes: filesBefore,
    };
  };
  const registerDisabled = async (scriptPath: string, phase: string) => {
    const escaped = scriptPath
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    const xml = disableScheduledTaskXmlForFixture(originalXml)
      .replace(/<Arguments>[\s\S]*?<\/Arguments>/u, "")
      .replace(/<WorkingDirectory>[\s\S]*?<\/WorkingDirectory>/u, "")
      .replace(command[0], `<Command>${escaped}</Command>`)
      .replace(/<Triggers>[\s\S]*?<\/Triggers>/u, "<Triggers />");
    assert.ok(xml.includes("<Triggers />"));
    assert.ok(xml.includes("<AllowStartOnDemand>false</AllowStartOnDemand>"));
    await fs.writeFile(definitionPath, `\uFEFF${xml}`, "utf16le");
    assert.equal(
      (await execSchtasks(["/Create", "/F", "/TN", task.taskName, "/XML", definitionPath])).code,
      0,
    );
    await recordProgress(`authority:registered:${phase}`);
    const observed = await snapshot(phase);
    assert.equal(observed.enabled, false);
    assert.equal(observed.taskState, 1);
    return observed;
  };
  const observations: Record<string, unknown> = {};
  let failure: Error | undefined;
  await withGatewayServiceOperationLock(task.env, async (assertCurrent) => {
    const inspect = async (expectedService: Admission = { serviceEnv: task.env }) => {
      const admitted = await maybeStopManagedServiceBeforeMutableUpdate({
        root: packageRoot(task.installRoot),
        expectedService,
        phase: "inspect",
        allowInstallRootChange: false,
        updateInstallKind: "package",
        shouldRestart: true,
        jsonMode: true,
        assertCurrent,
      });
      await recordProgress("authority:admission-inspected");
      return admitted;
    };
    const controlOptions = (before: Admission) => {
      const guard = createWindowsTaskAutoStartGuard({
        root: packageRoot(task.installRoot),
        before,
      });
      return {
        assertCurrent,
        beforeMutation: guard,
      };
    };
    const observeRefusal = async (
      operation: () => Promise<unknown>,
      message: string,
      phase: string,
    ) => {
      const prior = await snapshot(`${phase}:before`);
      assert.equal(prior.enabled, false);
      let refusal: { name: string; message: string } | undefined;
      await assert.rejects(operation, (error: unknown) => {
        assert.ok(error instanceof GatewayServiceUpdateOwnershipError);
        assert.equal(error.message, message);
        refusal = { name: error.name, message: error.message };
        return true;
      });
      await recordProgress(`authority:refusal:${phase}`);
      const after = await snapshot(`${phase}:after`);
      assert.deepEqual(after, prior);
      assert.ok(refusal);
      return { before: prior, refusal, after };
    };
    try {
      const disabled = await registerDisabled(scripts.owned, "owned");
      const admitted = await inspect();
      assert.equal(admitted.inspected, true);
      assert.equal(admitted.runtimeInspected, true);
      assert.equal(admitted.running, false);
      assert.equal(admitted.serviceUpdateVerdict?.kind, "owned");
      assert.equal(
        await resumeScheduledTaskAutoStartAfterUpdate(task.env, controlOptions(admitted)),
        true,
      );
      await recordProgress("authority:enabled");
      const enabled = await snapshot("enabled");
      assert.equal(enabled.enabled, true);
      assert.equal(enabled.taskState, 3);
      assert.equal(enabled.lastRunTime, disabled.lastRunTime);
      assert.equal(enabled.lastTaskResult, disabled.lastTaskResult);
      assert.equal(
        normalizeScheduledTaskXmlEnabledForFixture(enabled.xml),
        normalizeScheduledTaskXmlEnabledForFixture(disabled.xml),
      );
      assert.equal(
        await suspendScheduledTaskAutoStartForUpdate(task.env, controlOptions(admitted)),
        true,
      );
      await recordProgress("authority:disabled");
      assert.deepEqual(await snapshot("disabled"), disabled);
      observations.allowed = { admission: admitted.serviceUpdateVerdict, disabled, enabled };

      await registerDisabled(scripts.foreign, "foreign");
      const foreign = await inspect();
      assert.equal(foreign.serviceUpdateVerdict?.kind, "foreign");
      assert.equal(foreign.serviceMutationAllowed, false);
      observations.foreign = {
        admission: foreign.serviceUpdateVerdict,
        ...(await observeRefusal(
          () => resumeScheduledTaskAutoStartAfterUpdate(task.env, controlOptions(foreign)),
          "Windows task ownership could not be verified; inspect its autostart state manually.",
          "foreign",
        )),
      };

      await registerDisabled(scripts.owned, "retained");
      const retained = await inspect();
      assert.equal(retained.serviceUpdateVerdict?.kind, "owned");
      assert.ok(
        retained.serviceUpdateVerdict?.kind === "owned" &&
          retained.serviceUpdateVerdict.refreshDefinition,
      );
      await registerDisabled(scripts.reassigned, "reassigned");
      // Same-root refresh is legitimate after update; do not manufacture a restrictive verdict.
      await createWindowsTaskAutoStartGuard({
        root: packageRoot(task.installRoot),
        before: retained,
      })();
      await recordProgress("authority:retained-guard-verified");
      observations.retainedDefinitionChanged = {
        admission: retained.serviceUpdateVerdict,
        boundary: "maintenance retained admission; no native enable requested",
        change: "serial owned launcher/sourcePath change within the admitted package root",
        sameRootRefreshAllowed: true,
        ...(await observeRefusal(
          () => inspect(retained),
          "Gateway service definition changed after database admission; retry against its current configuration.",
          "retained-definition",
        )),
      };
    } catch (error) {
      failure = toErrorObject(error, "Native autostart authority fixture failed");
    }
    try {
      assertCurrent();
      assert.equal(
        (await execSchtasks(["/Create", "/F", "/TN", task.taskName, "/XML", restorePath])).code,
        0,
      );
      await recordProgress("authority:definition-restored");
      assert.equal(await readTaskXml(task.taskName), originalXml);
      assert.deepEqual(await fs.readFile(task.configPath), originalConfig);
      assert.equal(await hashFile(task.scriptPath), originalScriptHash);
      await snapshot("restored");
    } catch (error) {
      failure = new AggregateError(
        failure ? [failure, error] : [error],
        "Native autostart authority fixture restoration failed",
      );
    }
    if (failure) {
      throw failure;
    }
  });
  return {
    scope:
      "source-owner native /Change and retained admission; not installed update CLI final-I/O coverage",
    observations,
  };
}
