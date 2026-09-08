// Native proof uses only task-owned scratch jobs and a harmless synthetic CLI.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { noteMacForeignLaunchdJobs } from "../commands/doctor-foreign-launchd-jobs.js";
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

const hasGuiLaunchd =
  process.platform === "darwin" &&
  spawnSync("/bin/launchctl", ["print", `gui/${process.getuid?.()}`], {
    stdio: "ignore",
    timeout: 5000,
  }).status === 0;

it.skipIf(!hasGuiLaunchd)(
  "detects, reports and fixes only the scratch lifecycle job using native launchd",
  async () => {
    const prefix = `ai.openclaw.test.w15.${process.pid}.${randomUUID()}`;
    const labels = [prefix, `${prefix}.managed`, `com.example.w15.${process.pid}.${randomUUID()}`];
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
        if (label !== prefix || args[0] !== "bootout") {
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
      await fs.writeFile(script, `#!/bin/sh\nexec "${cli}" gateway restart\n`);
      for (const label of labels) {
        created.push(label);
        const result = native(["submit", "-l", label, "--", "/bin/sh", script]);
        expect(result, "scratch launchctl submit must not require privileges").toMatchObject({
          code: 0,
        });
      }
      const found = await findForeignLaunchdJobs(env);
      expect(found).toEqual([
        expect.objectContaining({
          label: prefix,
          program: "/bin/sh",
          keepAlive: true,
          gatewayActions: ["restart"],
          safeToRemove: true,
        }),
      ]);
      await noteMacForeignLaunchdJobs({ nonInteractive: true }, runtime, env);
      expect(vi.mocked(note).mock.calls.flat().join("\n")).toContain(prefix);
      expect(mutations).toEqual([]);
      await noteMacForeignLaunchdJobs({ repair: true, nonInteractive: true }, runtime, env);
      expect(log.mock.calls.flat().join("\n")).toContain(`Removed stray launchd job ${prefix}`);
      expect(mutations).toEqual([prefix]);
      expect(native(["print", `${domain}/${prefix}`]).code).not.toBe(0);
      for (const label of labels.slice(1)) {
        expect(native(["print", `${domain}/${label}`]).code).toBe(0);
      }
      console.log(
        "Native scratch proof: keepalive lifecycle job detected; Doctor report preserved it; --fix removed it; managed and unrelated scratch jobs remained loaded.",
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
