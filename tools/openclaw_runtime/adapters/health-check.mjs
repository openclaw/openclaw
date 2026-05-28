#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../../scripts/lib/sqlite-compat.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const NUWA_DB_PATH = path.resolve(
  __dirname,
  "../../../extensions/evolution-learning/.claude/evolution-state/nuwa.db",
);

function checkCliVersion(command) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, ["--version"], {
        shell: true,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      });
    } catch {
      resolve({ ok: false, version: null });
      return;
    }

    const chunks = [];

    child.stdout?.on("data", (chunk) => chunks.push(chunk));
    child.stderr?.on("data", (chunk) => chunks.push(chunk));

    child.on("error", () => {
      resolve({ ok: false, version: null });
    });

    child.on("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf8").trim();
      const version = output ? output.split(/\r?\n/)[0].slice(0, 200) : null;
      resolve({ ok: code === 0 && Boolean(version), version });
    });
  });
}

async function checkOllama() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch("http://localhost:11434/api/tags", {
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    const models = Array.isArray(json?.models) ? json.models : [];
    return { ok: response.ok, modelCount: models.length };
  } catch {
    return { ok: false, modelCount: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function checkDb() {
  let db;
  try {
    db = await openDb(NUWA_DB_PATH, { readonly: true, fileMustExist: true });

    const tableRow = db
      .prepare(`
      SELECT COUNT(*) AS table_count
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `)
      .get();
    const tableCount = Number(tableRow?.table_count ?? 0);

    let patternCount = 0;
    const hasPatternTable = db
      .prepare(`
      SELECT 1 AS ok
      FROM sqlite_master
      WHERE type = 'table' AND name = 'patterns'
      LIMIT 1
    `)
      .get();

    if (hasPatternTable) {
      const patternRow = db.prepare("SELECT COUNT(*) AS pattern_count FROM patterns").get();
      patternCount = Number(patternRow?.pattern_count ?? 0);
    }

    return { ok: true, tableCount, patternCount };
  } catch {
    return { ok: false, tableCount: 0, patternCount: 0 };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close failure
    }
  }
}

async function main() {
  const [claude, codex, ollama, db] = await Promise.all([
    checkCliVersion("claude"),
    checkCliVersion("codex"),
    checkOllama(),
    checkDb(),
  ]);

  const report = { claude, codex, ollama, db };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = claude.ok && codex.ok && ollama.ok && db.ok ? 0 : 1;
}

await main();
