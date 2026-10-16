import { logbookPortProvider } from "./logbook-port.js";
import { teamReportsPortProvider } from "./team-reports-port.js";
import { workboardPortProvider } from "./workboard-port.js";

export const updatePostgresFamilies = [
  {
    provider: workboardPortProvider,
    relativePath: "plugins/workboard/workboard.sqlite",
    seed: "PRAGMA user_version=3; INSERT INTO workboard_schema_migrations VALUES ('schema-3',1); INSERT INTO workboard_boards (id,name,created_at,updated_at) VALUES ('board','baseline',1,1)",
    table: "workboard_boards",
    column: "name",
  },
  {
    provider: logbookPortProvider,
    relativePath: "logbook/logbook.sqlite",
    seed: "PRAGMA user_version=1; INSERT INTO standups VALUES ('2026-10-16','baseline',1)",
    table: "standups",
    column: "text",
  },
  {
    provider: teamReportsPortProvider,
    relativePath: "plugins/team-reports/team-reports.sqlite",
    seed: "PRAGMA user_version=1; INSERT INTO team_reports_schema_migrations VALUES ('schema-1',1); INSERT INTO team_reports_periods VALUES ('day','2026-10-16',1,2,'closed',2,'{}',NULL,'baseline')",
    table: "team_reports_periods",
    column: "markdown",
  },
];
