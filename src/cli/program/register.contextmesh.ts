import type { Command } from "commander";
import {
  contextmeshApproveWorkerCommand,
  contextmeshBenchmarkCommand,
  contextmeshBenchmarksCommand,
  contextmeshCoordinatorStartCommand,
  contextmeshDemoCommand,
  contextmeshDoctorCommand,
  contextmeshStatusCommand,
  contextmeshSubmitCommand,
  contextmeshWorkerStartCommand,
  contextmeshWorkersCommand,
} from "../../commands/contextmesh.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { defaultRuntime } from "../../runtime.js";

export function registerContextMeshCommands(program: Command) {
  const cmd = program.command("contextmesh").description("Distributed large-context preprocessing");

  cmd.command("coordinator")
    .command("start")
    .requiredOption("--host <host>", "Bind host", "127.0.0.1")
    .requiredOption("--port <port>", "Bind port", "18791")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await contextmeshCoordinatorStartCommand({ host: String(opts.host), port: Number(opts.port) });
      });
    });

  cmd.command("status")
    .requiredOption("--coordinator <url>", "Coordinator base URL", "http://127.0.0.1:18791")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await contextmeshStatusCommand({ coordinator: String(opts.coordinator) });
      });
    });

  cmd.command("workers")
    .requiredOption("--coordinator <url>", "Coordinator base URL", "http://127.0.0.1:18791")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await contextmeshWorkersCommand({ coordinator: String(opts.coordinator) });
      });
    });

  cmd.command("approve-worker")
    .requiredOption("--coordinator <url>", "Coordinator base URL", "http://127.0.0.1:18791")
    .option("--worker-id <id>", "Worker id")
    .option("--request-id <id>", "Pending pairing request id")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await contextmeshApproveWorkerCommand({
          coordinator: String(opts.coordinator),
          workerId: opts.workerId as string | undefined,
          requestId: opts.requestId as string | undefined,
        });
      });
    });

  cmd.command("benchmark")
    .requiredOption("--coordinator <url>", "Coordinator base URL", "http://127.0.0.1:18791")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await contextmeshBenchmarkCommand({ coordinator: String(opts.coordinator) });
      });
    });

  cmd.command("benchmarks").action(async () => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      await contextmeshBenchmarksCommand();
    });
  });

  cmd.command("submit")
    .requiredOption("--coordinator <url>", "Coordinator base URL", "http://127.0.0.1:18791")
    .requiredOption("--file <path>", "Input file")
    .requiredOption("--mode <mode>", "summarize|qa|compress|keywords|entities|semantic_search")
    .option("--question <text>", "Question for qa mode")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await contextmeshSubmitCommand({
          coordinator: String(opts.coordinator),
          file: String(opts.file),
          mode: String(opts.mode),
          question: opts.question as string | undefined,
        });
      });
    });

  cmd.command("worker")
    .command("start")
    .requiredOption("--coordinator <url>", "Coordinator base URL")
    .requiredOption("--name <name>", "Worker display name")
    .option("--worker-id <id>", "Approved worker id")
    .option("--device-token <token>", "Approved worker device token")
    .option("--device-identity-path <path>", "Override worker device identity file")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await contextmeshWorkerStartCommand({
          coordinator: String(opts.coordinator),
          name: String(opts.name),
          workerId: opts.workerId as string | undefined,
          deviceToken: opts.deviceToken as string | undefined,
          deviceIdentityPath: opts.deviceIdentityPath as string | undefined,
        });
      });
    });

  cmd.command("doctor").action(async () => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      await contextmeshDoctorCommand();
    });
  });

  cmd.command("demo")
    .requiredOption("--coordinator <url>", "Coordinator base URL", "http://127.0.0.1:18791")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await contextmeshDemoCommand({ coordinator: String(opts.coordinator) });
      });
    });
}
