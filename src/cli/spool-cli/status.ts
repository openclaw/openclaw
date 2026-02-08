import type { Command } from "commander";
import { danger } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { countDeadLetterEvents } from "../../spool/dead-letter.js";
import { resolveSpoolEventsDir, resolveSpoolDeadLetterDir } from "../../spool/paths.js";
import { countSpoolEvents, listSpoolEvents } from "../../spool/reader.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";

export function registerSpoolStatusCommand(spool: Command) {
  spool
    .command("status")
    .description("Show spool status and pending events")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      try {
        const eventsDir = resolveSpoolEventsDir();
        const deadLetterDir = resolveSpoolDeadLetterDir();
        const pendingCount = await countSpoolEvents();
        const deadLetterCount = await countDeadLetterEvents();
        const events = await listSpoolEvents();

        if (opts.json) {
          defaultRuntime.log(
            JSON.stringify(
              {
                eventsDir,
                deadLetterDir,
                pendingCount,
                deadLetterCount,
                events,
              },
              null,
              2,
            ),
          );
          return;
        }

        const rich = isRich();
        defaultRuntime.log(colorize(rich, theme.heading, "Spool Status"));
        defaultRuntime.log("");
        defaultRuntime.log(`Events directory:      ${colorize(rich, theme.muted, eventsDir)}`);
        defaultRuntime.log(`Dead-letter directory: ${colorize(rich, theme.muted, deadLetterDir)}`);
        defaultRuntime.log("");
        defaultRuntime.log(
          `Pending events:   ${pendingCount === 0 ? colorize(rich, theme.success, "0") : colorize(rich, theme.warn, String(pendingCount))}`,
        );
        defaultRuntime.log(
          `Dead-letter:      ${deadLetterCount === 0 ? colorize(rich, theme.success, "0") : colorize(rich, theme.error, String(deadLetterCount))}`,
        );

        if (events.length > 0) {
          defaultRuntime.log("");
          defaultRuntime.log(colorize(rich, theme.heading, "Pending Events:"));
          for (const event of events.slice(0, 10)) {
            const priorityLabel =
              event.priority && event.priority !== "normal" ? ` [${event.priority}]` : "";
            const retryLabel =
              event.retryCount && event.retryCount > 0 ? ` (retry ${event.retryCount})` : "";
            const message =
              event.payload.message.length > 60
                ? `${event.payload.message.slice(0, 60)}...`
                : event.payload.message;
            defaultRuntime.log(
              `  ${colorize(rich, theme.accent, event.id.slice(0, 8))}${priorityLabel}${retryLabel}: ${message}`,
            );
          }
          if (events.length > 10) {
            defaultRuntime.log(`  ... and ${events.length - 10} more`);
          }
        }
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
