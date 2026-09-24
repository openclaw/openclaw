// Runs guard entry points without credentials or network access. Every API read
// must have an explicit fixture; writes are recorded for contract assertions.
import { appendFileSync, readFileSync } from "node:fs";
import { installGuardClock } from "./github-guard-clock.mjs";

const fixture = JSON.parse(readFileSync(process.env.OPENCLAW_GUARD_TEST_FIXTURE, "utf8"));
const advanceClock = fixture.clock ? installGuardClock(fixture.logPath) : undefined;
const publishedStatuses = new Map();
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  appendFileSync(fixture.logPath, `${JSON.stringify({ method, path: parsed.pathname, body })}\n`);
  const statusCommit = /^\/repos\/[^/]+\/[^/]+\/statuses\/([a-f0-9]{40})$/u.exec(parsed.pathname);
  const recordStatus = () => {
    if (method === "POST" && statusCommit) {
      const previous = publishedStatuses.get(statusCommit[1]) ?? [];
      publishedStatuses.set(statusCommit[1], [
        { ...body, creator: { login: "github-actions[bot]", type: "Bot" } },
        ...previous,
      ]);
    }
  };
  const key = `${method} ${parsed.pathname}`;
  const queryKey = `${key}${parsed.search}`;
  const route = Object.hasOwn(fixture.routes, queryKey)
    ? fixture.routes[queryKey]
    : fixture.routes[key];
  if (route === undefined) {
    if (method !== "GET" && /\/(?:statuses\/|issues\/)/u.test(parsed.pathname)) {
      recordStatus();
      return new Response(JSON.stringify({ id: 123 }), { status: 200 });
    }
    throw new Error(`Unexpected GitHub request: ${key}`);
  }
  const responseRoute = route.settlesAt
    ? Date.now() < Date.parse(route.settlesAt)
      ? route.before
      : route.after
    : route;
  let value = responseRoute.responses
    ? responseRoute.responses.length > 1
      ? responseRoute.responses.shift()
      : responseRoute.responses[0]
    : responseRoute;
  if (value?.advanceMs !== undefined) {
    if (!advanceClock) throw new Error("Elapsed response fixtures require the isolated clock.");
    advanceClock(value.advanceMs);
    value = value.response;
  }
  if (value?.requestTimeout) {
    const expire = () => advanceClock(30_000);
    if (value.requestTimeout === "body") {
      return new Response(new ReadableStream({ pull: expire }, { highWaterMark: 0 }));
    }
    expire();
    return new Promise(() => {});
  }
  if (value?.recordStatusBeforeError) recordStatus();
  if (value?.transportError) {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("Fixture connection failure"), { code: value.transportError }),
    });
  }
  if (value?.httpError) {
    return new Response(JSON.stringify({ message: value.message ?? "Fixture API failure" }), {
      status: value.httpError,
      headers: value.headers,
    });
  }
  recordStatus();
  const statusHistory = /^\/repos\/[^/]+\/[^/]+\/commits\/([a-f0-9]{40})\/statuses$/u.exec(
    parsed.pathname,
  );
  if (method === "GET" && statusHistory && Array.isArray(value)) {
    const page = Number(parsed.searchParams.get("page") ?? 1);
    const perPage = Number(parsed.searchParams.get("per_page") ?? 100);
    const statuses = [...(publishedStatuses.get(statusHistory[1]) ?? []), ...value];
    return new Response(JSON.stringify(statuses.slice((page - 1) * perPage, page * perPage)), {
      status: 200,
    });
  }
  return new Response(JSON.stringify(value), { status: 200 });
};
