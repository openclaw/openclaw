import { Command } from "commander";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { BridgeContext } from "../bridge/types.js";
import { wireModelsBridgeCommands } from "../bridge/commands/models.js";
import { bridgeRegistry } from "../bridge/registry.js";

// Schema for Bridge Input
const BridgeInputSchema = z.object({
  action: z.string(),
  args: z.record(z.string(), z.any()).optional(),
  context: z
    .object({
      channel: z.string().optional(),
      userId: z.string().optional(),
      isAdmin: z.boolean().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
    })
    .optional(),
});

// Wire all command modules explicitly
wireModelsBridgeCommands(bridgeRegistry);

export function registerBridgeCommand(program: Command) {
  program
    .command("bridge [payload]")
    .description("Execute internal commands via JSON bridge")
    .option("-f, --file <path>", "Read payload from file")
    .action(async (payloadStr, opts) => {
      try {
        let inputStr = payloadStr;

        // 1. Resolve Input
        if (opts.file) {
          inputStr = readFileSync(opts.file, "utf-8");
        } else if (!inputStr && !process.stdin.isTTY) {
          const chunks = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk);
          }
          inputStr = Buffer.concat(chunks).toString("utf-8");
        }

        if (!inputStr) {
          console.error(JSON.stringify({ success: false, error: "No input payload provided" }));
          process.exit(1);
        }

        // 2. Parse & Validate
        const json = JSON.parse(inputStr);
        const input = BridgeInputSchema.parse(json);

        // 3. Dispatch
        const command = bridgeRegistry.get(input.action);
        if (!command) {
          console.error(
            JSON.stringify({ success: false, error: `Unknown action: ${input.action}` }),
          );
          process.exit(1);
        }

        // 4. Validate args against command schema (if defined)
        const validatedArgs = command.schema
          ? command.schema.parse(input.args ?? command.defaultArgs ?? {})
          : (input.args ?? {});

        // 5. Execute
        const context: BridgeContext = {
          channel: input.context?.channel ?? "cli",
          userId: input.context?.userId,
          isAdmin: input.context?.isAdmin ?? true,
          metadata: input.context?.metadata,
        };
        const result = await command.handler(validatedArgs, context);

        // 6. Output
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(JSON.stringify({ success: false, error: String(err) }));
        process.exit(1);
      }
    });
}
