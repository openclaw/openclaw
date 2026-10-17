import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveLiveManagedGatewayDistFence } from "../../scripts/lib/live-gateway-dist-fence.mts";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-context-types.js";
import { inspectManagedGatewayServiceBeforeUpdate } from "../cli/update-cli/update-command-service-plan.js";
import { assertManagedGatewayArtifactPublication } from "../cli/update-cli/update-command-service-revalidation.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import * as nativeExec from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import * as inventory from "./inspect.js";
import * as launchdExec from "./launchd-exec.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import { readCorrespondingLaunchAgentCommand } from "./launchd-runtime.js";
import {
  discoverManagedGatewayBindings,
  readManagedGatewayBindingState,
} from "./managed-gateway-bindings.js";
import { readGatewayServiceState, resolveGatewayService } from "./service.js";

// Native command observations are controlled; discovery, plist decoding,
// binding selection, physical layout and publication admission are real.
afterEach(() => vi.restoreAllMocks());

type Install = "system" | "local" | "global";
type ScenarioOptions = {
  edited?: boolean;
  selected?:
    | "generated"
    | "native logging"
    | "authored logging"
    | "changed logging"
    | "extra environment"
    | "wrong native marker"
    | "changed env file"
    | "other definition"
    | "changed argv zero"
    | "explicit Program";
  observation?: "stopped" | "mismatch" | "mismatch-stopped" | "uncertain";
  customLabel?: boolean;
};
function makeScenario(
  loaded: Install,
  target: Install,
  refused: boolean,
  options: ScenarioOptions = {},
) {
  return { loaded, target, refused, edited: false, ...options };
}

it.each([
  makeScenario("system", "system", true),
  makeScenario("system", "local", false),
  makeScenario("system", "system", false, { observation: "stopped" }),
  makeScenario("system", "system", true, { observation: "mismatch" }),
  makeScenario("system", "local", false, { observation: "mismatch" }),
  makeScenario("system", "system", false, { observation: "mismatch-stopped" }),
  makeScenario("system", "system", true, { observation: "uncertain" }),
  makeScenario("local", "local", true),
  makeScenario("local", "global", false),
  makeScenario("global", "local", false),
  makeScenario("global", "global", true),
  makeScenario("local", "local", true, { edited: true }),
  makeScenario("local", "local", false, { selected: "generated" }),
  makeScenario("local", "local", true, { selected: "generated", observation: "mismatch" }),
  makeScenario("local", "local", false, { selected: "native logging" }),
  makeScenario("local", "local", false, { selected: "authored logging" }),
  makeScenario("local", "local", true, { selected: "changed logging" }),
  makeScenario("local", "local", true, { selected: "extra environment" }),
  makeScenario("local", "local", true, { selected: "wrong native marker" }),
  makeScenario("local", "local", true, { selected: "changed env file" }),
  makeScenario("global", "global", true, { selected: "other definition" }),
  makeScenario("local", "local", true, { selected: "changed argv zero" }),
  makeScenario("local", "local", false, { selected: "explicit Program" }),
  makeScenario("global", "global", true, { customLabel: true }),
])(
  "uses the loaded launchd definition: loaded=$loaded target=$target edited=$edited selected=$selected custom=$customLabel observation=$observation",
  async (scenario) =>
    withTestDir({ prefix: "launchd-loaded-install-" }, async (directory) => {
      mockProcessPlatform("darwin");
      const home = path.join(directory, "home");
      const customLabel = scenario.customLabel;
      const label = customLabel ? "org.example.shared-proof" : "ai.openclaw.shared-proof";
      const installLocation = (kind: string, base: string) => ({
        root: path.join(directory, `${kind}-install`),
        plist: path.join(base, "Library", "LaunchAgents", `${label}.plist`),
      });
      const locations = {
        local: installLocation("local", home),
        global: installLocation("global", path.join(directory, "global")),
      };
      const systemPlist = `/Library/LaunchDaemons/${label}.plist`;
      const systemFixturePlist = path.join(directory, "system.plist");
      const allLocations = {
        ...locations,
        system: { root: path.join(directory, "system-install"), plist: systemPlist },
      };
      const write = async (file: string, data: string) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, data);
      };
      const entry = (root: string) => path.join(root, "dist", "entry.js");
      const argv = (root: string) => [process.execPath, entry(root), "gateway"];
      const envFile = (root: string) => path.join(root, "service-env", `${label}.env`);
      const environment = {
        ...(customLabel ? {} : { OPENCLAW_PROFILE: "shared-proof" }),
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      };
      const selectedScenario = scenario.selected;
      const wrapped = selectedScenario && selectedScenario !== "explicit Program";
      const authoredLogging =
        selectedScenario === "authored logging" || selectedScenario === "changed logging"
          ? { OSLogRateLimit: "synthetic-authored-value" }
          : {};
      const rawArgv = (root: string) =>
        wrapped
          ? [
              "/bin/sh",
              path.join(root, "service-env", `${label}-env-wrapper.sh`),
              envFile(root),
              ...argv(root),
            ]
          : selectedScenario === "explicit Program"
            ? [path.join(directory, "argv-zero", "node"), ...argv(root).slice(1)]
            : argv(root);
      for (const [kind, location] of Object.entries(allLocations)) {
        await write(
          path.join(location.root, "package.json"),
          '{"name":"openclaw","version":"1.0.0"}',
        );
        await write(entry(location.root), "// synthetic serving artifact\n");
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
          programArguments: rawArgv(
            scenario.edited && kind === "local" ? locations.global.root : location.root,
          ),
          environment: wrapped ? authoredLogging : environment,
          stdoutPath: path.join(directory, "stdout.log"),
          stderrPath: path.join(directory, "stderr.log"),
        });
        if (selectedScenario === "explicit Program") {
          const executable = process.execPath
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");
          plist = plist.replace(
            "<key>ProgramArguments</key>",
            `<key>Program</key><string>${executable}</string>\n<key>ProgramArguments</key>`,
          );
        }
        await write(location.plist === systemPlist ? systemFixturePlist : location.plist, plist);
      }
      const readFile = fs.readFile;
      vi.spyOn(fs, "readFile").mockImplementation((file, options) =>
        readFile(file === systemPlist ? systemFixturePlist : file, options),
      );
      const services = Object.entries(allLocations).map(([kind, { plist }]) => ({
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
      const domain = scenario.loaded === "system" ? "system" : guiDomain;
      const loaded = allLocations[scenario.loaded];
      const observation = scenario.observation;
      const sourceMismatch = observation?.startsWith("mismatch") ?? false;
      const observedPlist = sourceMismatch
        ? path.join(directory, "loaded-elsewhere.plist")
        : loaded.plist;
      const stopped = observation === "stopped" || observation === "mismatch-stopped";
      const cleanupError = new CommandProcessCleanupError();
      const observedEnv: NodeJS.ProcessEnv = {
        ...(!selectedScenario || !wrapped ? environment : {}),
      };
      if (selectedScenario) {
        Object.assign(observedEnv, authoredLogging, {
          XPC_SERVICE_NAME: selectedScenario === "wrong native marker" ? "another.job" : label,
        });
        if (["native logging", "changed logging"].includes(selectedScenario)) {
          observedEnv.OSLogRateLimit = "synthetic-native-value";
        }
        if (selectedScenario === "extra environment") {
          observedEnv.NODE_OPTIONS = "--inspect=0";
        }
      }
      const print = [
        `${domain}/${label} = {`,
        `\tpath = ${observedPlist}`,
        `\ttype = ${scenario.loaded === "system" ? "LaunchDaemon" : "LaunchAgent"}`,
        `\tstate = ${stopped ? "exited" : "running"}`,
        ...(stopped ? [] : [`\tpid = ${process.pid}`]),
        `\tprogram = ${selectedScenario === "explicit Program" ? process.execPath : rawArgv(loaded.root)[0]}`,
        "\targuments = {",
        ...rawArgv(loaded.root).map(
          (arg, index) =>
            `\t\t${selectedScenario === "changed argv zero" && index === 0 ? "/different/argv-zero" : arg}`,
        ),
        "\t}",
        "\tenvironment = {",
        ...Object.entries(observedEnv).map(([name, value]) => `\t\t${name} => ${value}`),
        "\t}",
        "}",
      ].join("\n");
      const native = vi.spyOn(launchdExec, "execLaunchctl").mockImplementation(async (args) => {
        expect(args[0]).toBe("print");
        expect([`${guiDomain}/${label}`, `system/${label}`]).toContain(args[1]);
        if (args[1] === `${domain}/${label}` && observation === "uncertain") {
          throw cleanupError;
        }
        return args[1] === `${domain}/${label}`
          ? { code: 0, stdout: print, stderr: "", termination: "exit" }
          : { code: 113, stdout: "", stderr: "Could not find service", termination: "exit" };
      });
      let selected: PreManagedServiceStop | undefined;
      if (selectedScenario) {
        const state = await readGatewayServiceState(resolveGatewayService(), {
          env: { HOME: home, OPENCLAW_LAUNCHD_LABEL: label },
          requireEffective: true,
        });
        const verdict = await inspectManagedGatewayServiceBeforeUpdate({
          root: locations.local.root,
          state,
        });
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
        if (selectedScenario === "changed env file") {
          await fs.appendFile(
            envFile(locations.local.root),
            "\nexport NODE_OPTIONS='--inspect=0'\n",
          );
        }
      }
      const admission = assertManagedGatewayArtifactPublication({
        roots: [allLocations[scenario.target].root],
        env: { HOME: home },
        timeoutMs: 30_000,
        updateInstallKind: "package",
        shouldRestart: !selected,
        selected,
        assertCurrent: () => {},
      });
      if (observation === "uncertain") {
        await expect(admission).rejects.toBe(cleanupError);
        await expect(
          resolveLiveManagedGatewayDistFence(loaded.root, { env: { HOME: home } }),
        ).rejects.toBe(cleanupError);
        return;
      }
      if (scenario.refused) {
        await expect(admission).rejects.toMatchObject({ reason: "runtime-artifact-publication" });
        if (customLabel || scenario.loaded === "system" || sourceMismatch) {
          await expect(admission).rejects.toMatchObject({
            message: expect.stringContaining(observedPlist),
          });
          await expect(admission).rejects.toMatchObject({
            message: expect.stringContaining(`${domain}/${label}`),
          });
        }
      } else {
        await expect(admission).resolves.toBeUndefined();
      }
      if (
        ((scenario.loaded === "global" || scenario.loaded === "system") && !selectedScenario) ||
        sourceMismatch
      ) {
        const fence = await resolveLiveManagedGatewayDistFence(allLocations[scenario.target].root, {
          env: { HOME: home, OPENCLAW_LAUNCHD_LABEL: label },
        });
        expect(fence.refuse).toBe(scenario.refused);
        if ((customLabel || scenario.loaded === "system" || sourceMismatch) && fence.refuse) {
          expect(fence.message).toContain(observedPlist);
          expect(fence.message).toContain(`${domain}/${label}`);
          expect(fence.message).not.toContain("`openclaw gateway stop`");
          expect(fence.message).not.toContain("`openclaw gateway start`");
        }
      }
      if ((scenario.loaded === "system" && scenario.refused) || sourceMismatch) {
        const state = await readManagedGatewayBindingState({
          env: { HOME: home, OPENCLAW_LAUNCHD_LABEL: label },
          launchAgentPlistPath: loaded.plist,
        });
        expect(state).toMatchObject({
          launchAgent: { target: `${domain}/${label}`, sourcePath: observedPlist },
          command: { sourcePath: observedPlist },
        });
        await expect(
          readCorrespondingLaunchAgentCommand(
            { HOME: home, OPENCLAW_LAUNCHD_LABEL: label },
            state.launchAgent!,
            5_000,
          ),
        ).resolves.toBeNull();
        if (scenario.loaded === "system") {
          expect(
            inventory.renderGatewayServiceCleanupHints(
              services.filter((service) => service.sourcePath === systemPlist),
            ),
          ).toContain(`sudo launchctl bootout system/${label}`);
        }
      }
      if (scenario.loaded === "system") {
        expect(native).toHaveBeenCalledWith(["print", `system/${label}`], expect.any(Number));
      }
      expect(native).toHaveBeenCalled();
    }),
);

it.each([false, true])(
  "keeps invoking native selection first (strict=%s)",
  async (requireComplete) => {
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
    const bindings = await discoverManagedGatewayBindings(env, {
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
  },
);
