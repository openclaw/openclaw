import type { Command } from "commander";
import { workerTriggerLoopCommand } from "../../commands/worker-trigger.js";

export function registerWorkerCommands(program: Command) {
  const worker = program
    .command("worker")
    .description("Run bounded local worker control-plane commands");

  const trigger = worker
    .command("trigger")
    .description("Validate or run bounded worker trigger contracts");

  trigger
    .command("loop")
    .description("Run the local worker trigger loop contract without external dispatch")
    .action(async () => {
      await workerTriggerLoopCommand();
    });
}
