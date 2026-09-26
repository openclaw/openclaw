import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// The vitest UI project runs on Node worker threads (`isolate: false`), and
// worker threads cache their ICU default time zone at creation, ignoring
// later `process.env.TZ` writes. A real child process does not share that
// cache, so DST-crossing recency math is proven there instead.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "../../../..");
const targetModuleUrl = pathToFileURL(path.join(moduleDir, "proposal-records.ts")).href;

function recencyGroupFor(tz: string, nowIso: string, targetIso: string): string {
  const script = `
    const { proposalFromManifest } = await import(${JSON.stringify(targetModuleUrl)});
    Date.now = () => Date.parse(${JSON.stringify(nowIso)});
    const entry = {
      id: "proposal-1",
      kind: "create",
      status: "pending",
      title: "Inbox Cleaner",
      description: "Clean inbox triage",
      skillName: "Inbox Cleaner",
      skillKey: "inbox-cleaner",
      createdAt: ${JSON.stringify(targetIso)},
      updatedAt: ${JSON.stringify(targetIso)},
      scanState: "clean",
      revisionHash: "a".repeat(64),
    };
    process.stdout.write(proposalFromManifest(entry, undefined).recencyGroup);
  `;
  return execFileSync(
    process.execPath,
    ["--import", "./scripts/tsx.mjs", "--input-type=module", "-e", script],
    { cwd: repoRoot, env: { ...process.env, TZ: tz }, encoding: "utf8" },
  );
}

describe("recencyGroup across DST transitions", () => {
  it("classifies yesterday's proposal as yesterday across a spring-forward transition", () => {
    // 2026-03-08 is the US spring-forward date in America/New_York: the local
    // day from 2026-03-08 to 2026-03-09 is only 23 elapsed hours.
    const result = recencyGroupFor(
      "America/New_York",
      "2026-03-09T15:00:00.000Z",
      "2026-03-08T15:00:00.000Z",
    );
    expect(result).toBe("yesterday");
  });

  it("classifies yesterday's proposal as yesterday across a fall-back transition", () => {
    // 2026-11-01 is the US fall-back date in America/New_York: the local day
    // from 2026-11-01 to 2026-11-02 is 25 elapsed hours.
    const result = recencyGroupFor(
      "America/New_York",
      "2026-11-02T18:00:00.000Z",
      "2026-11-01T18:00:00.000Z",
    );
    expect(result).toBe("yesterday");
  });
});
