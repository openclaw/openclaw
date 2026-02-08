import type { Command } from "commander";
import { loadScheduleFile } from "../../schedule/store.js";
import { renderTable } from "../../terminal/table.js";
import { theme } from "../../terminal/theme.js";
import { displayString } from "../../utils.js";

export function registerScheduleListCommand(schedule: Command) {
  schedule
    .command("list")
    .description("List scheduled jobs")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const file = await loadScheduleFile();
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(file.jobs, null, 2)}\n`);
        return;
      }

      if (file.jobs.length === 0) {
        process.stdout.write(`${theme.muted("No scheduled jobs.")}\n`);
        return;
      }

      const rows = file.jobs.map((j) => ({
        id: j.id,
        description: j.description ?? "",
        cmd: displayString([j.cmd, ...(j.args ?? [])].join(" ")),
        cwd: j.cwd ? displayString(j.cwd) : "",
        updatedAt: j.updatedAt,
      }));

      process.stdout.write(
        `${renderTable({
          columns: [
            { key: "id", header: "ID", minWidth: 10 },
            { key: "description", header: "Description", flex: true, minWidth: 12 },
            { key: "cmd", header: "Command", flex: true, minWidth: 20 },
            { key: "cwd", header: "CWD", flex: true, minWidth: 10 },
            { key: "updatedAt", header: "Updated", minWidth: 20 },
          ],
          rows,
        })}\n`,
      );
    });
}
