import type { Command } from "commander";
import fs from "node:fs/promises";
import type { SpoolPriority } from "../../spool/types.js";
import type { SpoolEvent } from "../../spool/types.js";
import { danger } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import {
  SPOOL_PRIORITY_VALUES,
  validateSpoolEvent,
  validateSpoolEventCreate,
  validateSpoolPayload,
} from "../../spool/schema.js";
import { createSpoolAgentTurn, createSpoolEvent, writeSpoolEvent } from "../../spool/writer.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";

export function registerSpoolEnqueueCommand(spool: Command) {
  spool
    .command("enqueue")
    .description("Enqueue a new spool event")
    .option("--message <text>", "Message to send to the agent")
    .option("--file <path>", "Path to JSON file with event payload")
    .option("--agent <id>", "Agent ID (optional)")
    .option("--session <key>", "Session key override (optional)")
    .option("--model <model>", "Model override (provider/model or alias)")
    .option("--thinking <level>", "Thinking level (off|minimal|low|medium|high|xhigh)")
    .option("--priority <level>", "Priority (low|normal|high|critical)", "normal")
    .option("--max-retries <n>", "Maximum retry attempts (default: from config or 3)")
    .option("--expires-in <duration>", "Expiration duration (e.g., 1h, 30m)")
    .option("--deliver", "Enable delivery of agent response", false)
    .option("--channel <channel>", "Delivery channel (e.g., whatsapp, telegram)")
    .option("--to <dest>", "Delivery destination")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      try {
        const hasMessage = typeof opts.message === "string" && opts.message.trim();
        const hasFile = typeof opts.file === "string" && opts.file.trim();

        if (!hasMessage && !hasFile) {
          throw new Error("Either --message or --file is required");
        }

        if (hasMessage && hasFile) {
          throw new Error("Cannot use both --message and --file");
        }

        let event;

        if (hasFile) {
          // Load from file
          const content = await fs.readFile(opts.file, "utf8");
          const data = JSON.parse(content);

          // Check if it's a full event or just a create request
          if (data.id && data.createdAt && data.createdAtMs) {
            // Full event - validate and write as-is to preserve metadata
            const validation = validateSpoolEvent(data);
            if (!validation.valid) {
              throw new Error(`Invalid event file: ${validation.error}`);
            }
            event = data as SpoolEvent;
            await writeSpoolEvent(event);
          } else if (data.version === 1 && data.payload) {
            // Create request - validate before creating
            const createValidation = validateSpoolEventCreate(data);
            if (!createValidation.valid) {
              throw new Error(`Invalid create request: ${createValidation.error}`);
            }
            event = await createSpoolEvent(createValidation.create);
          } else if (data.kind === "agentTurn" && data.message) {
            // Just a payload - validate before creating
            const payloadValidation = validateSpoolPayload(data);
            if (!payloadValidation.valid) {
              throw new Error(`Invalid payload: ${payloadValidation.error}`);
            }
            event = await createSpoolEvent({
              version: 1,
              payload: payloadValidation.payload,
            });
          } else {
            throw new Error(
              "Invalid file format. Expected a spool event, create request, or payload.",
            );
          }
        } else {
          // Create from CLI options
          const priorityRaw = opts.priority ?? "normal";
          if (!SPOOL_PRIORITY_VALUES.includes(priorityRaw)) {
            throw new Error(
              `Invalid --priority value: "${priorityRaw}". Must be one of: ${SPOOL_PRIORITY_VALUES.join(", ")}`,
            );
          }
          const priority = priorityRaw as SpoolPriority;
          // Only set maxRetries if explicitly provided; otherwise leave undefined
          // so dispatcher uses cfg.spool.maxRetries (or its default of 3)
          let maxRetries: number | undefined;
          if (opts.maxRetries !== undefined) {
            const maxRetriesRaw = Number.parseInt(opts.maxRetries, 10);
            if (!Number.isFinite(maxRetriesRaw) || maxRetriesRaw < 0) {
              throw new Error(
                `Invalid --max-retries value: "${opts.maxRetries}". Must be a non-negative integer.`,
              );
            }
            maxRetries = maxRetriesRaw;
          }
          let expiresAt: string | undefined;

          if (opts.expiresIn) {
            const duration = parseDuration(opts.expiresIn);
            if (duration === null) {
              throw new Error(
                `Invalid --expires-in value: "${opts.expiresIn}". Expected format like "1h", "30m", "5s", "500ms", "1d".`,
              );
            }
            expiresAt = new Date(Date.now() + duration).toISOString();
          }

          const delivery =
            opts.deliver || opts.channel || opts.to
              ? {
                  // Only set enabled if --deliver was explicitly passed; otherwise leave
                  // undefined so the runner can use auto-delivery mode when recipient is set
                  enabled: opts.deliver === true ? true : undefined,
                  channel: opts.channel,
                  to: opts.to,
                }
              : undefined;

          event = await createSpoolAgentTurn(opts.message, {
            agentId: opts.agent,
            sessionKey: opts.session,
            model: opts.model,
            thinking: opts.thinking,
            priority,
            maxRetries,
            expiresAt,
            delivery,
          });
        }

        if (opts.json) {
          defaultRuntime.log(JSON.stringify(event, null, 2));
          return;
        }

        const rich = isRich();
        defaultRuntime.log(
          `${colorize(rich, theme.success, "Enqueued")} event ${colorize(rich, theme.accent, event.id)}`,
        );
        defaultRuntime.log(
          `Message: ${event.payload.message.length > 80 ? `${event.payload.message.slice(0, 80)}...` : event.payload.message}`,
        );
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}

function parseDuration(input: string): number | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (!match) {
    return null;
  }
  const n = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  const unit = (match[2] ?? "").toLowerCase();
  const factor =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  return Math.floor(n * factor);
}
