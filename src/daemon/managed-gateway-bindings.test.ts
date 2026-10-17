import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveLiveManagedGatewayDistFence as resolveFence } from "../../scripts/lib/live-gateway-dist-fence.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-context-types.js";
import { inspectManagedGatewayServiceBeforeUpdate } from "../cli/update-cli/update-command-service-plan.js";
import { assertManagedGatewayArtifactPublication } from "../cli/update-cli/update-command-service-revalidation.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import * as nativeExec from "../process/exec.js";
import { escapeXml } from "../shared/xml.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import * as inventory from "./inspect.js";
import * as launchdExec from "./launchd-exec.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import { readCorrespondingLaunchAgentCommand as readCommand } from "./launchd-runtime.js";
import * as bindingOwner from "./managed-gateway-bindings.js";
import { readGatewayServiceState, resolveGatewayService } from "./service.js";

// Native command observations are controlled; discovery, plist decoding,
// binding selection, physical layout and publication admission are real.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  ["system", "system", true, {}],
  ["system", "local", false, {}],
  ["system", "system", false, { observation: "stopped" }],
  ["system", "system", true, { observation: "mismatch" }],
  ["system", "local", false, { observation: "mismatch" }],
  ["system", "system", false, { observation: "mismatch-stopped" }],
  ["system", "system", true, { observation: "uncertain" }],
  ["local", "local", true, {}],
  ["local", "global", false, {}],
  ["global", "local", false, {}],
  ["global", "global", true, {}],
  ["local", "local", true, { edited: true }],
  ["local", "local", false, { selected: "generated" }],
  ["local", "local", true, { selected: "generated", observation: "mismatch" }],
  ["local", "local", false, { selected: "native logging" }],
  ["local", "local", false, { selected: "authored logging" }],
  ["local", "local", true, { selected: "changed logging" }],
  ["local", "local", true, { selected: "extra environment" }],
  ["local", "local", true, { selected: "wrong native marker" }],
  ["local", "local", true, { selected: "changed env file" }],
  ["global", "global", true, { selected: "other definition" }],
  ["local", "local", true, { selected: "changed argv zero" }],
  ["local", "local", false, { selected: "explicit Program" }],
  ["global", "global", true, { customLabel: true }],
] as const)(
  "uses loaded launchd definition: loaded=%s target=%s refused=%s options=%j",
  async (loadedKind, targetKind, refused, scenario) => {
    const directory = tempDirs.make("launchd-loaded-install-");
    mockProcessPlatform("darwin");
    const home = path.join(directory, "home");
    const hostEnv = { HOME: home };
    const customLabel = "customLabel" in scenario;
    const edited = "edited" in scenario;
    const label = customLabel ? "org.example.shared-proof" : "ai.openclaw.shared-proof";
    const serviceEnv = { ...hostEnv, OPENCLAW_LAUNCHD_LABEL: label };
    const installLocation = (kind: string, base: string) => ({
      root: path.join(directory, `${kind}-install`),
      plist: path.join(base, "Library", "LaunchAgents", `${label}.plist`),
    });
    const systemPlist = `/Library/LaunchDaemons/${label}.plist`;
    const systemFixturePlist = path.join(directory, "system.plist");
    const locations = {
      local: installLocation("local", home),
      global: installLocation("global", path.join(directory, "global")),
      system: { root: path.join(directory, "system-install"), plist: systemPlist },
    };
    const localRoot = locations.local.root;
    const write = async (file: string, data: string) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, data);
    };
    const argv = (root: string) => [process.execPath, path.join(root, "dist/entry.js"), "gateway"];
    const envFile = (root: string) => path.join(root, "service-env", `${label}.env`);
    const environment = {
      ...(customLabel ? {} : { OPENCLAW_PROFILE: "shared-proof" }),
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
    };
    const variant = "selected" in scenario ? scenario.selected : undefined;
    const wrapped = variant && variant !== "explicit Program";
    const authoredLogging =
      variant === "authored logging" || variant === "changed logging"
        ? { OSLogRateLimit: "synthetic-authored-value" }
        : {};
    const rawArgv = (root: string) => {
      const command = argv(root);
      if (variant === "explicit Program") {
        command[0] = path.join(directory, "argv-zero/node");
      }
      if (!wrapped) {
        return command;
      }
      const wrapper = path.join(root, "service-env", `${label}-env-wrapper.sh`);
      return ["/bin/sh", wrapper, envFile(root), ...command];
    };
    const packageJson = '{"name":"openclaw","version":"1.0.0"}';
    for (const [kind, location] of Object.entries(locations)) {
      const commandRoot = edited && kind === "local" ? locations.global.root : location.root;
      await write(path.join(location.root, "package.json"), packageJson);
      await write(path.join(location.root, "dist/entry.js"), "// synthetic serving artifact\n");
      if (wrapped) {
        await write(
          envFile(location.root),
          Object.entries(environment)
            .map(([name, value]) => `export ${name}='${value}'`)
            .join("\n"),
        );
      }
      let plist = buildLaunchAgentPlist({
        label,
        programArguments: rawArgv(commandRoot),
        environment: wrapped ? authoredLogging : environment,
        stdoutPath: path.join(directory, "stdout.log"),
        stderrPath: path.join(directory, "stderr.log"),
      });
      if (variant === "explicit Program") {
        plist = plist.replace(
          "<key>ProgramArguments</key>",
          `<key>Program</key><string>${escapeXml(process.execPath)}</string>\n<key>ProgramArguments</key>`,
        );
      }
      await write(location.plist === systemPlist ? systemFixturePlist : location.plist, plist);
    }
    const readFile = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementation((file, options) =>
      readFile(file === systemPlist ? systemFixturePlist : file, options),
    );
    const services = Object.entries(locations).map(([kind, { plist }]) => ({
      platform: "darwin" as const,
      label,
      detail: `plist: ${plist}`,
      sourcePath: plist,
      scope: kind === "local" ? ("user" as const) : ("system" as const),
      marker: "openclaw",
    }));
    vi.spyOn(inventory, "listManagedOpenClawGatewayServices").mockResolvedValue({
      services,
      errors: [],
    });
    vi.spyOn(nativeExec, "runExec").mockImplementation(async (bin, args, options) => {
      expect(bin).toBe("/usr/bin/plutil");
      if (typeof options !== "object" || options.input === undefined) {
        throw new Error("Fixture requires captured plist bytes");
      }
      return decodeLaunchAgentPlistFixture(options.input, args[1]);
    });
    const guiDomain = `gui/${process.getuid?.() ?? 501}`;
    const domain = loadedKind === "system" ? "system" : guiDomain;
    const nativeTarget = `${domain}/${label}`;
    const loaded = locations[loadedKind];
    const observation = "observation" in scenario ? scenario.observation : undefined;
    const sourceMismatch = observation?.startsWith("mismatch") ?? false;
    const observedPlist = sourceMismatch
      ? path.join(directory, "loaded-elsewhere.plist")
      : loaded.plist;
    const stopped = observation === "stopped" || observation === "mismatch-stopped";
    const describeOwner = customLabel || loadedKind === "system" || sourceMismatch;
    const cleanupError = new CommandProcessCleanupError();
    const observedEnv: NodeJS.ProcessEnv = { ...(wrapped ? authoredLogging : environment) };
    if (variant) {
      observedEnv.XPC_SERVICE_NAME = variant === "wrong native marker" ? "another.job" : label;
    }
    if (variant === "native logging" || variant === "changed logging") {
      observedEnv.OSLogRateLimit = "synthetic-native-value";
    }
    if (variant === "extra environment") {
      observedEnv.NODE_OPTIONS = "--inspect=0";
    }
    const nativeArgs = rawArgv(loaded.root);
    const program = variant === "explicit Program" ? process.execPath : nativeArgs[0];
    if (variant === "changed argv zero") {
      nativeArgs[0] = "/different/argv-zero";
    }
    const block = (name: string, lines: string[]) =>
      `\t${name} = {\n${lines.map((line) => `\t\t${line}`).join("\n")}\n\t}`;
    const envLines = Object.entries(observedEnv).map(([name, value]) => `${name} => ${value}`);
    const print = `${nativeTarget} = {
\tpath = ${observedPlist}
\tstate = ${stopped ? "exited" : "running"}
${stopped ? "" : `\tpid = ${process.pid}\n`}\tprogram = ${program}
${block("arguments", nativeArgs)}
${block("environment", envLines)}
}`;
    vi.spyOn(launchdExec, "execLaunchctl").mockImplementation(async (args) => {
      expect(args[0]).toBe("print");
      expect([`${guiDomain}/${label}`, `system/${label}`]).toContain(args[1]);
      if (args[1] === nativeTarget && observation === "uncertain") {
        throw cleanupError;
      }
      return args[1] === nativeTarget
        ? { code: 0, stdout: print, stderr: "", termination: "exit" }
        : { code: 113, stdout: "", stderr: "Could not find service", termination: "exit" };
    });
    let selected: PreManagedServiceStop | undefined;
    if (variant) {
      const state = await readGatewayServiceState(resolveGatewayService(), {
        env: serviceEnv,
        requireEffective: true,
      });
      const verdict = await inspectManagedGatewayServiceBeforeUpdate({ root: localRoot, state });
      expect(verdict.kind).toBe("owned");
      selected = {
        inspected: true,
        runtimeInspected: true,
        running: true,
        stopped: false,
        servicePid: process.pid,
        serviceEnv: state.env,
        serviceUpdateVerdict: verdict,
      };
      if (variant === "changed env file") {
        await fs.appendFile(envFile(localRoot), "\nexport NODE_OPTIONS='--inspect=0'\n");
      }
    }
    const admission = assertManagedGatewayArtifactPublication({
      roots: [locations[targetKind].root],
      env: hostEnv,
      timeoutMs: 30_000,
      updateInstallKind: "package",
      shouldRestart: !selected,
      selected,
      assertCurrent: () => {},
    });
    if (observation === "uncertain") {
      await expect(admission).rejects.toBe(cleanupError);
      await expect(resolveFence(loaded.root, { env: hostEnv })).rejects.toBe(cleanupError);
      return;
    }
    if (refused) {
      await expect(admission).rejects.toMatchObject({ reason: "runtime-artifact-publication" });
      if (describeOwner) {
        for (const detail of [observedPlist, nativeTarget]) {
          await expect(admission).rejects.toThrow(detail);
        }
      }
    } else {
      await expect(admission).resolves.toBeUndefined();
    }
    if (((loadedKind === "global" || loadedKind === "system") && !variant) || sourceMismatch) {
      const fence = await resolveFence(locations[targetKind].root, { env: serviceEnv });
      expect(fence.refuse).toBe(refused);
      if (describeOwner && fence.refuse) {
        expect(fence.message).toContain(observedPlist);
        expect(fence.message).toContain(nativeTarget);
        expect(fence.message).not.toMatch(/`openclaw gateway (?:stop|start)`/);
      }
    }
    if ((loadedKind === "system" && refused) || sourceMismatch) {
      const state = await bindingOwner.readManagedGatewayBindingState({
        env: serviceEnv,
        launchAgentPlistPath: loaded.plist,
      });
      expect(state).toMatchObject({
        launchAgent: { target: nativeTarget, sourcePath: observedPlist },
        command: { sourcePath: observedPlist },
      });
      await expect(readCommand(serviceEnv, state.launchAgent!, 5_000)).resolves.toBeNull();
      if (loadedKind === "system") {
        const systemServices = services.filter((service) => service.sourcePath === systemPlist);
        expect(inventory.renderGatewayServiceCleanupHints(systemServices)).toContain(
          `sudo launchctl bootout system/${label}`,
        );
      }
    }
  },
);

it.each([false, true])("prefers invoking selection (strict=%s)", async (requireComplete) => {
  mockProcessPlatform("linux");
  const env = {
    HOME: "/synthetic/service-home",
    OPENCLAW_PROFILE: "selected",
    OPENCLAW_SYSTEMD_UNIT: "custom-selected.service",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic/selected-bus",
  };
  const sibling = {
    platform: "linux" as const,
    scope: "user" as const,
    label: "custom-sibling.service",
    detail: "unit: /synthetic/custom-sibling.service",
    sourcePath: "/synthetic/custom-sibling.service",
  };
  vi.spyOn(inventory, "listManagedOpenClawGatewayServices").mockResolvedValue({
    services: [sibling, sibling],
    errors: [],
  });
  const reads = vi
    .spyOn(fs, "readFile")
    .mockRejectedValue(new Error("Unexpected definition reread"));
  const bindings = await bindingOwner.discoverManagedGatewayBindings(env, {
    requireComplete,
    includeInvoking: true,
  });
  expect(bindings).toHaveLength(2);
  expect(bindings[0]?.env).toEqual(env);
  expect(bindings[1]).toMatchObject({
    env: {
      OPENCLAW_SYSTEMD_UNIT: sibling.label,
      DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS,
    },
    systemdReadTarget: {
      scope: "user",
      unitName: sibling.label,
      unitPath: "/synthetic/custom-sibling.service",
    },
  });
  expect(bindings[1]?.env.OPENCLAW_PROFILE).toBeUndefined();
  expect(reads).not.toHaveBeenCalled();
});
