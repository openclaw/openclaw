import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveLiveManagedGatewayDistFence } from "../../scripts/lib/live-gateway-dist-fence.mts";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-context-types.js";
import { inspectManagedGatewayServiceBeforeUpdate } from "../cli/update-cli/update-command-service-plan.js";
import { assertManagedGatewayArtifactPublication } from "../cli/update-cli/update-command-service-revalidation.js";
import * as nativeExec from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import * as inventory from "./inspect.js";
import * as launchdExec from "./launchd-exec.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import { readGatewayServiceState, resolveGatewayService } from "./service.js";

// Native command observations are controlled; discovery, plist decoding,
// binding selection, physical layout and publication admission are real.
afterEach(() => vi.restoreAllMocks());

it.each([
  { loaded: "local", target: "local", edited: false, refused: true },
  { loaded: "local", target: "global", edited: false, refused: false },
  { loaded: "global", target: "local", edited: false, refused: false },
  { loaded: "global", target: "global", edited: false, refused: true },
  { loaded: "local", target: "local", edited: true, refused: true },
  { loaded: "local", target: "local", edited: false, refused: false, selected: "generated" },
  { loaded: "local", target: "local", edited: false, refused: false, selected: "native logging" },
  { loaded: "local", target: "local", edited: false, refused: false, selected: "authored logging" },
  { loaded: "local", target: "local", edited: false, refused: true, selected: "changed logging" },
  { loaded: "local", target: "local", edited: false, refused: true, selected: "extra environment" },
  {
    loaded: "local",
    target: "local",
    edited: false,
    refused: true,
    selected: "wrong native marker",
  },
  { loaded: "local", target: "local", edited: false, refused: true, selected: "changed env file" },
  {
    loaded: "global",
    target: "global",
    edited: false,
    refused: true,
    selected: "other definition",
  },
  { loaded: "local", target: "local", edited: false, refused: true, selected: "changed argv zero" },
  { loaded: "local", target: "local", edited: false, refused: false, selected: "explicit Program" },
  { loaded: "global", target: "global", edited: false, refused: true, customLabel: true },
] as const)(
  "uses the loaded LaunchAgent definition: loaded=$loaded target=$target edited=$edited selected=$selected custom=$customLabel",
  async (scenario) =>
    withTestDir({ prefix: "launchd-loaded-install-" }, async (directory) => {
      mockProcessPlatform("darwin");
      const home = path.join(directory, "home");
      const customLabel = "customLabel" in scenario;
      const label = customLabel ? "org.example.shared-proof" : "ai.openclaw.shared-proof";
      const locations = {
        local: {
          root: path.join(directory, "local-install"),
          plist: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
        },
        global: {
          root: path.join(directory, "global-install"),
          plist: path.join(directory, "global", "Library", "LaunchAgents", `${label}.plist`),
        },
      };
      for (const location of Object.values(locations)) {
        await fs.mkdir(path.join(location.root, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(location.root, "package.json"),
          JSON.stringify({ name: "openclaw", version: "1.0.0" }),
        );
        await fs.writeFile(
          path.join(location.root, "dist", "entry.js"),
          "// synthetic serving artifact\n",
        );
        await fs.mkdir(path.dirname(location.plist), { recursive: true });
      }
      const argv = (root: string) => [
        process.execPath,
        path.join(root, "dist", "entry.js"),
        "gateway",
      ];
      const environment = {
        ...(customLabel ? {} : { OPENCLAW_PROFILE: "shared-proof" }),
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      };
      const selectedScenario = "selected" in scenario ? scenario.selected : undefined;
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
              path.join(root, "service-env", `${label}.env`),
              ...argv(root),
            ]
          : selectedScenario === "explicit Program"
            ? [path.join(directory, "argv-zero", "node"), ...argv(root).slice(1)]
            : argv(root);
      for (const [kind, location] of Object.entries(locations)) {
        if (wrapped) {
          await fs.mkdir(path.join(location.root, "service-env"), { recursive: true });
          await fs.writeFile(
            path.join(location.root, "service-env", `${label}.env`),
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
        await fs.writeFile(location.plist, plist);
      }
      vi.spyOn(inventory, "listManagedOpenClawGatewayServices").mockResolvedValue({
        services: [
          {
            platform: "darwin",
            label,
            detail: `plist: ${locations.local.plist}`,
            scope: "user",
            marker: "openclaw",
          },
          {
            platform: "darwin",
            label,
            detail: `plist: ${locations.global.plist}`,
            scope: "system",
            marker: "openclaw",
          },
        ],
        errors: [],
      });
      vi.spyOn(nativeExec, "runExec").mockImplementation(async (bin, args, options) => {
        expect(bin).toBe("/usr/bin/plutil");
        if (typeof options !== "object" || options.input === undefined) {
          throw new Error("Fixture requires captured plist bytes");
        }
        return decodeLaunchAgentPlistFixture(options.input, args[1]);
      });
      const domain = `gui/${process.getuid?.() ?? 501}`;
      const loaded = locations[scenario.loaded];
      const print = [
        `${domain}/${label} = {`,
        `\tpath = ${loaded.plist}`,
        "\ttype = LaunchAgent",
        "\tstate = running",
        `\tpid = ${process.pid}`,
        `\tprogram = ${selectedScenario === "explicit Program" ? process.execPath : rawArgv(loaded.root)[0]}`,
        "\targuments = {",
        ...rawArgv(loaded.root).map(
          (arg, index) =>
            `\t\t${selectedScenario === "changed argv zero" && index === 0 ? "/different/argv-zero" : arg}`,
        ),
        "\t}",
        "\tenvironment = {",
        ...Object.entries(
          selectedScenario
            ? {
                ...(wrapped ? {} : environment),
                XPC_SERVICE_NAME:
                  selectedScenario === "wrong native marker" ? "another.job" : label,
                ...authoredLogging,
                ...(selectedScenario === "native logging" || selectedScenario === "changed logging"
                  ? { OSLogRateLimit: "synthetic-native-value" }
                  : {}),
                ...(selectedScenario === "extra environment"
                  ? { NODE_OPTIONS: "--inspect=0" }
                  : {}),
              }
            : environment,
        ).map(([name, value]) => `\t\t${name} => ${value}`),
        "\t}",
        "}",
      ].join("\n");
      const native = vi.spyOn(launchdExec, "execLaunchctl").mockImplementation(async (args) => {
        expect(args[0]).toBe("print");
        expect([`${domain}/${label}`, `system/${label}`]).toContain(args[1]);
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
            path.join(locations.local.root, "service-env", `${label}.env`),
            "\nexport NODE_OPTIONS='--inspect=0'\n",
          );
        }
      }
      const admission = assertManagedGatewayArtifactPublication({
        roots: [locations[scenario.target].root],
        env: { HOME: home },
        timeoutMs: 30_000,
        updateInstallKind: "package",
        shouldRestart: !selected,
        selected,
        assertCurrent: () => {},
      });
      if (scenario.refused) {
        await expect(admission).rejects.toMatchObject({ reason: "runtime-artifact-publication" });
        if (customLabel) {
          await expect(admission).rejects.toMatchObject({
            message: expect.stringContaining(loaded.plist),
          });
          await expect(admission).rejects.toMatchObject({
            message: expect.stringContaining(`${domain}/${label}`),
          });
        }
      } else {
        await expect(admission).resolves.toBeUndefined();
      }
      if (scenario.loaded === "global" && !selectedScenario) {
        const fence = await resolveLiveManagedGatewayDistFence(locations[scenario.target].root, {
          env: { HOME: home, OPENCLAW_LAUNCHD_LABEL: label },
        });
        expect(fence.refuse).toBe(scenario.refused);
        if (customLabel && fence.refuse) {
          expect(fence.message).toContain(loaded.plist);
          expect(fence.message).toContain(`${domain}/${label}`);
          expect(fence.message).not.toContain("`openclaw gateway stop`");
          expect(fence.message).not.toContain("`openclaw gateway start`");
        }
      }
      expect(native).toHaveBeenCalled();
    }),
);
