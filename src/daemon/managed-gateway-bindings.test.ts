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
  async (loadedKind, targetKind, refused, scenario) =>
    withTestDir({ prefix: "launchd-loaded-install-" }, async (directory) => {
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
      const variant = "selected" in scenario ? scenario.selected : undefined;
      const wrapped = variant && variant !== "explicit Program";
      const authoredLogging =
        variant === "authored logging" || variant === "changed logging"
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
          : variant === "explicit Program"
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
            edited && kind === "local" ? locations.global.root : location.root,
          ),
          environment: wrapped ? authoredLogging : environment,
          stdoutPath: path.join(directory, "stdout.log"),
          stderrPath: path.join(directory, "stderr.log"),
        });
        if (variant === "explicit Program") {
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
      const domain = loadedKind === "system" ? "system" : guiDomain;
      const nativeTarget = `${domain}/${label}`;
      const targetRoot = allLocations[targetKind].root;
      const loaded = allLocations[loadedKind];
      const observation = "observation" in scenario ? scenario.observation : undefined;
      const sourceMismatch = observation?.startsWith("mismatch") ?? false;
      const observedPlist = sourceMismatch
        ? path.join(directory, "loaded-elsewhere.plist")
        : loaded.plist;
      const stopped = observation === "stopped" || observation === "mismatch-stopped";
      const describeOwner = customLabel || loadedKind === "system" || sourceMismatch;
      const cleanupError = new CommandProcessCleanupError();
      const observedEnv: NodeJS.ProcessEnv = {
        ...(!variant || !wrapped ? environment : {}),
      };
      if (variant) {
        Object.assign(observedEnv, authoredLogging, {
          XPC_SERVICE_NAME: variant === "wrong native marker" ? "another.job" : label,
        });
        if (["native logging", "changed logging"].includes(variant)) {
          observedEnv.OSLogRateLimit = "synthetic-native-value";
        }
        if (variant === "extra environment") {
          observedEnv.NODE_OPTIONS = "--inspect=0";
        }
      }
      const print = [
        `${nativeTarget} = {`,
        `\tpath = ${observedPlist}`,
        `\ttype = ${loadedKind === "system" ? "LaunchDaemon" : "LaunchAgent"}`,
        `\tstate = ${stopped ? "exited" : "running"}`,
        ...(stopped ? [] : [`\tpid = ${process.pid}`]),
        `\tprogram = ${variant === "explicit Program" ? process.execPath : rawArgv(loaded.root)[0]}`,
        "\targuments = {",
        ...rawArgv(loaded.root).map(
          (arg, index) =>
            `\t\t${variant === "changed argv zero" && index === 0 ? "/different/argv-zero" : arg}`,
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
        if (variant === "changed env file") {
          await fs.appendFile(
            envFile(locations.local.root),
            "\nexport NODE_OPTIONS='--inspect=0'\n",
          );
        }
      }
      const admission = assertManagedGatewayArtifactPublication({
        roots: [targetRoot],
        env: hostEnv,
        timeoutMs: 30_000,
        updateInstallKind: "package",
        shouldRestart: !selected,
        selected,
        assertCurrent: () => {},
      });
      if (observation === "uncertain") {
        await expect(admission).rejects.toBe(cleanupError);
        await expect(
          resolveLiveManagedGatewayDistFence(loaded.root, { env: hostEnv }),
        ).rejects.toBe(cleanupError);
        return;
      }
      if (refused) {
        await expect(admission).rejects.toMatchObject({ reason: "runtime-artifact-publication" });
        if (describeOwner) {
          for (const detail of [observedPlist, nativeTarget]) {
            await expect(admission).rejects.toMatchObject({
              message: expect.stringContaining(detail),
            });
          }
        }
      } else {
        await expect(admission).resolves.toBeUndefined();
      }
      if (((loadedKind === "global" || loadedKind === "system") && !variant) || sourceMismatch) {
        const fence = await resolveLiveManagedGatewayDistFence(targetRoot, { env: serviceEnv });
        expect(fence.refuse).toBe(refused);
        if (describeOwner && fence.refuse) {
          expect(fence.message).toContain(observedPlist);
          expect(fence.message).toContain(nativeTarget);
          expect(fence.message).not.toContain("`openclaw gateway stop`");
          expect(fence.message).not.toContain("`openclaw gateway start`");
        }
      }
      if ((loadedKind === "system" && refused) || sourceMismatch) {
        const state = await readManagedGatewayBindingState({
          env: serviceEnv,
          launchAgentPlistPath: loaded.plist,
        });
        expect(state).toMatchObject({
          launchAgent: { target: nativeTarget, sourcePath: observedPlist },
          command: { sourcePath: observedPlist },
        });
        await expect(
          readCorrespondingLaunchAgentCommand(serviceEnv, state.launchAgent!, 5_000),
        ).resolves.toBeNull();
        if (loadedKind === "system") {
          expect(
            inventory.renderGatewayServiceCleanupHints(
              services.filter((service) => service.sourcePath === systemPlist),
            ),
          ).toContain(`sudo launchctl bootout system/${label}`);
        }
      }
      if (loadedKind === "system") {
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
