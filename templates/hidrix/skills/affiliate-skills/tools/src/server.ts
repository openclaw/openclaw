/**
 * affiliate-check persistent daemon
 * Bun HTTP server that caches API responses from list.affitor.com
 * Auto-shuts down after 30 min idle. Pattern from gstack/browse.
 */

import { fetchPrograms, type SearchParams } from "./api";
import { cache } from "./cache";
import {
  formatProgramCard,
  formatProgramTable,
  formatComparison,
  formatFreeTierNotice,
  formatError,
  formatStatus,
} from "./format";

const PORT_RANGE_START = 9500;
const PORT_RANGE_END = 9510;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const STATE_FILE = "/tmp/affiliate-check.json";

let lastActivity = Date.now();
let startTime = Date.now();
let idleTimer: ReturnType<typeof setTimeout>;
const apiKey = process.env.AFFITOR_API_KEY || "";

function resetIdleTimer() {
  lastActivity = Date.now();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log("[affiliate-check] Idle timeout — shutting down");
    cleanup();
    process.exit(0);
  }, IDLE_TIMEOUT_MS);
}

function cacheKey(params: SearchParams): string {
  return JSON.stringify(params);
}

function uptimeStr(): string {
  const ms = Date.now() - startTime;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

async function handleRequest(req: Request): Promise<Response> {
  resetIdleTimer();

  const url = new URL(req.url);
  const path = url.pathname;

  // Health check
  if (path === "/health") {
    return Response.json({ status: "ok", uptime: uptimeStr() });
  }

  // Status
  if (path === "/status") {
    const stats = cache.stats();
    const output = formatStatus({
      uptime: uptimeStr(),
      cache: { entries: stats.entries, oldestAge: stats.oldestAge },
      apiKey: !!apiKey,
      port: parseInt(url.port),
    });
    return new Response(output, { headers: { "Content-Type": "text/plain" } });
  }

  // Stop server
  if (path === "/stop") {
    setTimeout(() => {
      cleanup();
      process.exit(0);
    }, 100);
    return new Response("Shutting down.\n", { headers: { "Content-Type": "text/plain" } });
  }

  // Search programs
  if (path === "/search") {
    const params: SearchParams = {
      q: url.searchParams.get("q") || undefined,
      type: (url.searchParams.get("type") as SearchParams["type"]) || "affiliate_program",
      sort: (url.searchParams.get("sort") as SearchParams["sort"]) || "trending",
      limit: parseInt(url.searchParams.get("limit") || "10"),
      reward_type: url.searchParams.get("reward_type") || undefined,
      tags: url.searchParams.get("tags") || undefined,
      min_cookie_days: url.searchParams.get("min_cookie_days")
        ? parseInt(url.searchParams.get("min_cookie_days")!)
        : undefined,
    };

    const key = cacheKey(params);
    let programs = cache.get(key);
    let fromCache = true;

    if (!programs) {
      fromCache = false;
      try {
        const response = await fetchPrograms(params, apiKey || undefined);
        programs = response.data;
        cache.set(key, programs);

        if (response.tier === "free") {
          const output = formatProgramTable(programs) + formatFreeTierNotice();
          return new Response(output, { headers: { "Content-Type": "text/plain" } });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(formatError(msg), {
          status: 502,
          headers: { "Content-Type": "text/plain" },
        });
      }
    }

    const output = formatProgramTable(programs);
    return new Response(output, { headers: { "Content-Type": "text/plain" } });
  }

  // Top programs
  if (path === "/top") {
    const sort = (url.searchParams.get("sort") as SearchParams["sort"]) || "top";
    const limit = parseInt(url.searchParams.get("limit") || "10");
    const params: SearchParams = { sort, limit, type: "affiliate_program" };

    const key = cacheKey({ ...params, _cmd: "top" } as any);
    let programs = cache.get(key);

    if (!programs) {
      try {
        const response = await fetchPrograms(params, apiKey || undefined);
        programs = response.data;
        cache.set(key, programs);

        if (response.tier === "free") {
          const output = formatProgramTable(programs) + formatFreeTierNotice();
          return new Response(output, { headers: { "Content-Type": "text/plain" } });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(formatError(msg), {
          status: 502,
          headers: { "Content-Type": "text/plain" },
        });
      }
    }

    const output = formatProgramTable(programs);
    return new Response(output, { headers: { "Content-Type": "text/plain" } });
  }

  // Info (single program by name search)
  if (path === "/info") {
    const name = url.searchParams.get("name");
    if (!name) {
      return new Response(formatError("Usage: affiliate-check info <program-name>"), {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const key = `info:${name}`;
    let programs = cache.get(key);

    if (!programs) {
      try {
        const response = await fetchPrograms(
          { q: name, limit: 1, type: "affiliate_program" },
          apiKey || undefined,
        );
        programs = response.data;
        if (programs.length > 0) cache.set(key, programs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(formatError(msg), {
          status: 502,
          headers: { "Content-Type": "text/plain" },
        });
      }
    }

    if (!programs || programs.length === 0) {
      return new Response(formatError(`No program found matching "${name}".`), {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const output = formatProgramCard(programs[0]);
    return new Response(output, { headers: { "Content-Type": "text/plain" } });
  }

  // Compare (multiple programs)
  if (path === "/compare") {
    const names = url.searchParams
      .get("names")
      ?.split(",")
      .map((n) => n.trim());
    if (!names || names.length < 2) {
      return new Response(
        formatError("Usage: affiliate-check compare <program1> <program2> [program3...]"),
        { status: 400, headers: { "Content-Type": "text/plain" } },
      );
    }

    const programs = [];
    for (const name of names) {
      try {
        const response = await fetchPrograms(
          { q: name, limit: 1, type: "affiliate_program" },
          apiKey || undefined,
        );
        if (response.data.length > 0) {
          programs.push(response.data[0]);
        }
      } catch (err) {
        // Skip failed lookups
      }
    }

    if (programs.length < 2) {
      return new Response(formatError("Could not find enough programs to compare."), {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const output = formatComparison(programs);
    return new Response(output, { headers: { "Content-Type": "text/plain" } });
  }

  return new Response(
    `\n  affiliate-check server\n\n  Endpoints:\n    /search?q=...    Search programs\n    /top             Top programs\n    /info?name=...   Program details\n    /compare?names=a,b  Compare programs\n    /status          Server status\n    /health          Health check\n    /stop            Stop server\n\n`,
    { headers: { "Content-Type": "text/plain" } },
  );
}

function cleanup() {
  clearTimeout(idleTimer);
  try {
    const fs = require("fs");
    fs.unlinkSync(STATE_FILE);
  } catch {}
}

async function findPort(): Promise<number> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    try {
      const server = Bun.serve({ port, fetch: () => new Response("") });
      server.stop(true);
      return port;
    } catch {
      continue;
    }
  }
  throw new Error(`No available port in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

async function main() {
  const port = await findPort();
  const token = crypto.randomUUID();

  const server = Bun.serve({
    port,
    fetch: handleRequest,
  });

  // Write state file
  const state = {
    port,
    pid: process.pid,
    token,
    started: new Date().toISOString(),
  };
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));

  startTime = Date.now();
  resetIdleTimer();

  console.log(`[affiliate-check] Server running on port ${port} (PID ${process.pid})`);
  console.log(`[affiliate-check] API key: ${apiKey ? "configured" : "not set (free tier)"}`);
  console.log(`[affiliate-check] Auto-shutdown after 30 min idle`);

  // Handle signals
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

main();
