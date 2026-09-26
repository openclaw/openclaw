// @vitest-environment node
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("groups proposal dates by local calendar days across daylight-saving changes", () => {
  // V8 worker threads do not reliably observe TZ changes; one isolated process
  // exercises both clock transitions and year rollover with real local dates.
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
        import { proposalFromManifest } from ${JSON.stringify(new URL("./proposal-records.ts", import.meta.url).href)};
        const groups = [[2026, 2, 9], [2026, 10, 2], [2026, 0, 1]].map(([year, month, day]) => {
          Date.now = () => new Date(year, month, day, 12).getTime();
          return [0, 1, 2].map((daysAgo) => {
            const date = new Date(year, month, day - daysAgo, 12).toISOString();
            return proposalFromManifest({
              id: "calendar-proposal", kind: "create", status: "pending",
              title: "Calendar proposal", description: "Synthetic calendar fixture",
              skillName: "calendar", skillKey: "calendar", createdAt: date, updatedAt: date,
            }).recencyGroup;
          });
        });
        process.stdout.write(JSON.stringify(groups));
      `,
    ],
    {
      cwd: new URL("../../../../", import.meta.url),
      env: { ...process.env, TZ: "America/Los_Angeles" },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(JSON.parse(output)).toEqual([
    ["today", "yesterday", "earlier"],
    ["today", "yesterday", "earlier"],
    ["today", "yesterday", "earlier"],
  ]);
});
