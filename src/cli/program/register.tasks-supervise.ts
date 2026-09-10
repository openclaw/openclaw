import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerSupervisedTasksCommand(tasks: Command): void {
  const supervised = tasks
    .command("supervise")
    .description("Run and inspect durable supervised TaskFlow episodes (PoC)");
  const load = () => import("../../commands/tasks-supervise.js");
  supervised
    .command("work")
    .description("Own automatic continuation until stopped; recover persisted work on startup")
    .action(async () =>
      runCommandWithRuntime(defaultRuntime, async () =>
        (await load()).workSupervisedTasksCommand(defaultRuntime),
      ),
    );
  for (const action of ["start", "run"] as const) {
    supervised
      .command(`${action} <definition>`)
      .description(
        action === "run"
          ? "Admit a JSON task and supervise it in the foreground to an endpoint"
          : "Admit a JSON task to an already running supervisor",
      )
      .action(async (definition: string) =>
        runCommandWithRuntime(defaultRuntime, async () =>
          (await load()).startSupervisedTaskCommand(definition, action === "run", defaultRuntime),
        ),
      );
  }
  supervised
    .command("list")
    .description("List up to 256 retained episodes as JSON")
    .action(async () =>
      runCommandWithRuntime(defaultRuntime, async () =>
        (await load()).listSupervisedTasksCommand(defaultRuntime),
      ),
    );
  supervised
    .command("show <flowId>")
    .description("Inspect task state and freshness-qualified continuation custody")
    .action(async (flowId: string) =>
      runCommandWithRuntime(defaultRuntime, async () =>
        (await load()).showSupervisedTaskCommand(flowId, defaultRuntime),
      ),
    );
  supervised
    .command("control <request>")
    .description("Apply an exact-revision JSON cancel, steer, resume, or artifact acceptance")
    .action(async (request: string) =>
      runCommandWithRuntime(defaultRuntime, async () =>
        (await load()).controlSupervisedTaskCommand(request, defaultRuntime),
      ),
    );
  supervised
    .command("cancel <flowId>")
    .description("Record cancellation and revoke the current attempt")
    .action(async (flowId: string) =>
      runCommandWithRuntime(defaultRuntime, async () =>
        (await load()).cancelSupervisedTaskCommand(flowId, defaultRuntime),
      ),
    );
  supervised
    .command("resume <flowId> <response>")
    .description("Open a new episode from an input endpoint using an explicit JSON response")
    .action(async (flowId: string, response: string) =>
      runCommandWithRuntime(defaultRuntime, async () =>
        (await load()).resumeSupervisedTaskCommand(flowId, response, defaultRuntime),
      ),
    );
}
