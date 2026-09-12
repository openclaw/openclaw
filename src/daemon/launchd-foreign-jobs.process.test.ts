// Native proof uses only task-owned scratch jobs and a harmless synthetic CLI.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { noteMacForeignLaunchdJobs } from "../commands/doctor-foreign-launchd-jobs.js";
import { runGatewayServicesHealth } from "../flows/doctor-health-contribution-runners.gateway.js";
import { createDoctorHealthFlowContext } from "../flows/doctor-health-contributions.test-support.js";
import { execLaunchctl } from "./launchd-exec.js";
import { findForeignLaunchdJobs } from "./launchd-foreign-jobs.js";

vi.mock("./launchd-exec.js", async (original) => ({
  ...(await original<typeof import("./launchd-exec.js")>()),
  execLaunchctl: vi.fn(),
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
// Isolate Doctor's account policy and lifecycle history from the operator's install.
vi.mock("../config/paths.js", async (original) => ({
  ...(await original<typeof import("../config/paths.js")>()),
  isDefaultInstallIdentity: () => true,
}));
vi.mock("../commands/doctor-service-repair-policy.js", () => ({
  resolveServiceRepairPolicy: () => "auto",
  shouldManageGatewayService: async () => true,
}));
vi.mock("./restart-storm.js", () => ({
  readGatewayForcedRestartSummary: () => ({ count: 0, windowMs: 600_000 }),
}));
vi.mock("../commands/doctor-gateway-services.js", () => {
  const forbidden = () => {
    throw new Error("Native scratch proof must not enter managed-service repair");
  };
  return {
    maybeRepairGatewayServiceConfig: forbidden,
    maybeResolveDuelingSystemdGatewayScopes: forbidden,
    maybeScanExtraGatewayServices: forbidden,
  };
});

const hasGuiLaunchd =
  process.platform === "darwin" &&
  spawnSync("/bin/launchctl", ["print", `gui/${process.getuid?.()}`], {
    stdio: "ignore",
    timeout: 5000,
  }).status === 0;

it.skipIf(!hasGuiLaunchd).each(["interpreter", "direct"] as const)(
  "detects, reports and fixes only the scratch lifecycle job using native launchd (%s)",
  async (mode) => {
    const prefix = `ai.openclaw.test.w15.${process.pid}.${randomUUID()}`;
    const lifecycleLabel = `${prefix}.restart`;
    const observerLabel = `${prefix}.observer`;
    const labels = [lifecycleLabel, `${prefix}.managed`, observerLabel];
    const domain = `gui/${process.getuid?.()}`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-w15-native-"));
    const created: string[] = [];
    const mutations: string[] = [];
    const native = (args: string[]) => {
      const result = spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 5000 });
      if (result.error) {
        throw result.error;
      }
      return {
        code: result.status ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
        termination: "exit" as const,
      };
    };
    const env = { HOME: dir, OPENCLAW_LAUNCHD_LABEL: labels[1] };
    const log = vi.fn();
    const runtime = { log, error: vi.fn(), exit: vi.fn() };
    vi.mocked(execLaunchctl).mockImplementation(async (args) => {
      if (args[0] === "list") {
        const result = native(args);
        // Expose real native records for our jobs only. Never grant the Doctor
        // experiment access to the operator's jobs, even if a regression broadens it.
        return {
          ...result,
          stdout: result.stdout
            .split("\n")
            .filter((line) => labels.includes(line.trim().split(/\s+/).at(-1) ?? ""))
            .join("\n"),
        };
      }
      const label = args[1]?.slice(`${domain}/`.length);
      if (!label || !labels.includes(label)) {
        throw new Error("Native test refused an operation outside its scratch labels");
      }
      if (args[0] !== "print") {
        if (label !== lifecycleLabel || args[0] !== "bootout") {
          throw new Error("Native test refused a mutation of a protected scratch job");
        }
        mutations.push(label);
      }
      return native(args);
    });
    const errors: unknown[] = [];
    try {
      const cli = path.join(dir, "openclaw");
      const script = path.join(dir, "validator.sh");
      await fs.writeFile(cli, "#!/bin/sh\nexec /bin/sleep 120\n", { mode: 0o700 });
      expect(cli).toMatch(/^[A-Za-z0-9_./-]+$/);
      await fs.writeFile(
        script,
        `#!/bin/bash\nopenclaw_bin=${cli}\n"$openclaw_bin" gateway restart\nfor attempt in 1 2; do\n  "$openclaw_bin" gateway status\n  /bin/sleep 1\ndone\n`,
        { mode: 0o700 },
      );
      for (const label of labels) {
        created.push(label);
        const command =
          label === observerLabel
            ? ["/bin/sleep", "120"]
            : mode === "direct"
              ? [script]
              : ["/bin/bash", script];
        const result = native(["submit", "-l", label, "--", ...command]);
        expect(result, "scratch launchctl submit must not require privileges").toMatchObject({
          code: 0,
        });
      }
      const found = await findForeignLaunchdJobs(env);
      expect(found).toHaveLength(2);
      expect(found).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: lifecycleLabel,
            program: mode === "direct" ? script : "/bin/bash",
            keepAlive: true,
            gatewayActions: ["restart"],
            safeToRemove: true,
          }),
          expect.objectContaining({
            label: observerLabel,
            gatewayActions: [],
            safeToRemove: false,
          }),
        ]),
      );
      await noteMacForeignLaunchdJobs({ nonInteractive: true }, runtime, env);
      expect(vi.mocked(note).mock.calls.flat().join("\n")).toContain(prefix);
      expect(mutations).toEqual([]);
      await runGatewayServicesHealth(
        createDoctorHealthFlowContext({
          options: { repair: true, nonInteractive: true },
          gatewayMaintenanceActive: true,
          runtime,
          env,
        }),
      );
      expect(log.mock.calls.flat().join("\n")).toContain(
        `Removed stray launchd job ${lifecycleLabel}`,
      );
      expect(mutations).toEqual([lifecycleLabel]);
      expect(native(["print", `${domain}/${lifecycleLabel}`]).code).not.toBe(0);
      for (const label of labels.slice(1)) {
        expect(native(["print", `${domain}/${label}`]).code).toBe(0);
      }
      console.log(
        `Native scratch proof (${mode}): keepalive lifecycle job detected; Doctor report preserved it; maintenance-owned --fix removed it; managed and observer scratch jobs remained loaded.`,
      );
    } catch (error) {
      errors.push(error);
    }
    let cleanupFailed = false;
    for (const label of created) {
      try {
        native(["remove", label]);
        expect(native(["print", `${domain}/${label}`]).code).not.toBe(0);
      } catch (error) {
        cleanupFailed = true;
        errors.push(error);
      }
    }
    if (!cleanupFailed) {
      await fs
        .rm(dir, { recursive: true, force: true })
        .catch((error: unknown) => errors.push(error));
    }
    if (errors.length) {
      throw new AggregateError(
        errors,
        cleanupFailed
          ? `Scratch launchd cleanup failed; scripts retained at ${dir}`
          : "Scratch launchd proof failed",
      );
    }
  },
  30_000,
);
