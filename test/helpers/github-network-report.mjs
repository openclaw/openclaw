import fs from "node:fs";
import path from "node:path";

/** Read only settled run-owned snapshots. Zero-attempt processes create no file. */
export function readGitHubTestReports(directory) {
  const report = { incidental: 0, negativeControl: 0, omittedAttributions: 0, attempts: new Map() };
  function visit(root) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith("github-commands-")) visit(file);
      else if (entry.isFile() && /^[\da-f-]{36}-\d+\.json$/u.test(entry.name)) {
        const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const key of ["incidental", "negativeControl", "omittedAttributions"])
          report[key] += snapshot[key];
        for (const attempt of snapshot.attempts) {
          const key = JSON.stringify([attempt.kind, attempt.file, attempt.test, attempt.transport]);
          const previous = report.attempts.get(key);
          if (previous) previous.count += attempt.count;
          else if (report.attempts.size < 100) report.attempts.set(key, { ...attempt });
          else report.omittedAttributions += attempt.count;
        }
      }
    }
  }
  visit(directory);
  return { ...report, attempts: [...report.attempts.values()] };
}

export function printGitHubTestReport(report) {
  console.error(
    `[github-test-guard] blocked: unexpected=${report.incidental}, negative-controls=${report.negativeControl}, omitted-attributions=${report.omittedAttributions}`,
  );
  const unexpected = report.attempts.filter((attempt) => attempt.kind === "incidental");
  for (const attempt of unexpected.slice(0, 20)) {
    console.error(
      `[github-test-guard] ${attempt.count} ${attempt.transport}: ${attempt.file} > ${attempt.test}`,
    );
  }
  if (unexpected.length > 20)
    console.error(
      `[github-test-guard] ${unexpected.length - 20} additional attributions retained in reports`,
    );
}
