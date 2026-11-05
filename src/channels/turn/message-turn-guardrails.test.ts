import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";
import { runChannelTurn } from "./run-channel-turn.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const lowLevelHistoryHelpers =
  /\b(?:buildInboundHistoryFromMap|buildHistoryContextFromMap|buildPendingHistoryContextFromMap|clearHistoryEntriesIfEnabled|recordPendingHistoryEntryIfEnabled|recordPendingHistoryEntryWithMedia)\b/;

const legacyReplyHistoryCompatibilityFiles = new Set([
  "extensions/mattermost/runtime-api.ts",
  "extensions/mattermost/src/mattermost/runtime-api.ts",
]);

const excluded =
  /(?:^|\/)(?:\.cache|\.turbo|build|coverage|dist|node_modules|tmp)\/|\.d\.ts$|\.test\./;

const importOrExportPattern =
  /\b(?:import|export)\s*\{([\s\S]*?)\}\s*from\s*["']openclaw\/plugin-sdk\/reply-history["']/g;

it("drops when ingest returns null", async () => {
  const result = await runChannelTurn({
    channel: "test",
    raw: {},
    adapter: { ingest: () => null, resolveTurn: vi.fn() },
  });

  expect(result).toEqual({
    admission: { kind: "drop", reason: "ingest-null" },
    dispatched: false,
  });
});

it("keeps plugin runtime imports off low-level reply-history helpers", () => {
  const files = expectDefined(
    listGitTrackedFiles({ repoRoot, pathspecs: "extensions" }),
    "migration guardrails require a Git checkout",
  );
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    if (
      !file.endsWith(".ts") ||
      excluded.test(file) ||
      legacyReplyHistoryCompatibilityFiles.has(file)
    ) {
      continue;
    }
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const bindings = Array.from(source.matchAll(importOrExportPattern), ([, names]) => names).join(
      " ",
    );
    expect(bindings, file).not.toMatch(lowLevelHistoryHelpers);
  }
});
