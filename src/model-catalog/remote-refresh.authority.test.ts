import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { LookupFn } from "../infra/net/ssrf.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { refreshRemoteModelCatalog } from "./remote-refresh.js";

const { dnsLookup } = vi.hoisted(() => ({ dnsLookup: vi.fn<LookupFn>() }));

// Control only external DNS preparation; the guard, dispatcher, config owner, and HTTP are real.
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup: dnsLookup,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  clearRuntimeConfigSnapshot();
  await closeStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.for([
  { redirect: false, withdraw: false },
  { redirect: false, withdraw: true },
  { redirect: true, withdraw: false },
  { redirect: true, withdraw: true },
])("checks current policy after DNS preparation %j", async ({ redirect, withdraw }, { signal }) => {
  const events: string[] = ["policy grants 127.0.0.1"];
  let effects = 0;
  let redirectEffects = 0;
  const server = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer((request, response) => {
        if (request.url === "/redirect") {
          redirectEffects += 1;
          response.writeHead(302, { location: "/catalog" }).end();
        } else {
          effects += 1;
          response.end(
            JSON.stringify({
              schemaVersion: 2,
              generatedAt: 1_753_500_000_000,
              sourceCommit: "fixture",
              providers: { anthropic: {} },
              models: [
                { id: "claude-test", provider: "anthropic", pricing: { status: "unknown" } },
              ],
            }),
          );
        }
      }),
  });
  const ready = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let lookups = 0;
  dnsLookup.mockImplementation(async () => {
    if (++lookups === (redirect ? 2 : 1)) {
      events.push("DNS preparation paused");
      ready.resolve();
      await resume.promise;
      events.push("DNS preparation resumed");
    }
    return [{ address: "127.0.0.1", family: 4 }];
  });
  const config: OpenClawConfig = {
    models: {
      catalogRefresh: {
        url: "http://127.0.0.1:" + server.claim.port + (redirect ? "/redirect" : "/catalog"),
      },
    },
    tools: { web: { fetch: { ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } } } },
  };
  setRuntimeConfigSnapshot(config);
  const pending = refreshRemoteModelCatalog({
    config,
    force: true,
    signal,
    databaseOptions: { path: path.join(tempDirs.make("catalog-authority-"), "state.sqlite") },
  });
  try {
    await withinTest(ready.promise, signal);
    const next: OpenClawConfig = structuredClone(config);
    if (withdraw) {
      next.tools = { web: { fetch: { ssrfPolicy: { blockedHostnames: ["127.0.0.1"] } } } };
    }
    setRuntimeConfigSnapshot(next);
    events.push(
      withdraw
        ? "current config replaced: permission withdrawn"
        : "current config replaced: equivalent permission",
    );
    resume.resolve();
    const result = await withinTest(pending, signal);
    events.push(
      "result=" +
        result.status +
        (result.status === "error" ? " (" + result.error + ")" : "") +
        "; target HTTP effects=" +
        effects +
        "; prior redirect HTTP effects=" +
        redirectEffects,
    );
    console.log(events.join(" -> "));
    expect(effects).toBe(withdraw ? 0 : 1);
    expect(redirectEffects).toBe(redirect ? 1 : 0);
    if (withdraw) {
      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining("network policy changed"),
      });
    } else {
      expect(result.status).not.toBe("error");
    }
  } finally {
    resume.resolve();
    await pending;
    server.listener.closeAllConnections();
    await server.releaseListener();
    await server.claim.release();
  }
});
