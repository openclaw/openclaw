import { afterEach, describe, expect, it } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createPublicSessionRepresentationCache } from "./control-ui-public-session-cache.js";

const config = {};
const sessionKey = "agent:main:public-example";
const caches: ReturnType<typeof createPublicSessionRepresentationCache>[] = [];
function createCache() {
  const cache = createPublicSessionRepresentationCache();
  caches.push(cache);
  return cache;
}
afterEach(() => {
  for (const cache of caches.splice(0)) {
    cache.dispose();
  }
});

describe("public transcript representation cache", () => {
  it("shares one immutable representation until its own transcript or publication changes", () => {
    const cache = createCache();
    const result = cache.begin("page", sessionKey, config).complete("Published text");
    expect(cache.get("page", config)).toBe(result);
    sessionChanges.emit({ sessionKey: "agent:main:other" });
    expect(cache.get("page", config)).toBe(result);
    emitSessionTranscriptUpdate({ sessionKey, sessionId: "generation", agentId: "main" });
    expect(cache.get("page", config)).toBeUndefined();
    cache.begin("page", sessionKey, config).complete("Revised text");
    sessionChanges.emit({ sessionKey });
    expect(cache.get("page", config)).toBeUndefined();
  });

  it("cannot restore content from work that crossed revocation, rewrite, or shutdown", () => {
    const cache = createCache();
    const pending = cache.begin("page", sessionKey, config);
    sessionChanges.emit({ sessionKey });
    const replacement = cache.begin("page", sessionKey, config).complete("Replacement");
    expect(pending.complete("Must not return")).toBeUndefined();
    pending.cancel();
    expect(cache.get("page", config)).toBe(replacement);
    const closing = cache.begin("next", sessionKey, config);
    cache.dispose();
    expect(closing.complete("Must not return")).toBeUndefined();
    expect(cache.get("page", config)).toBeUndefined();
  });

  it("invalidates all representations for topology and unresolved transcript changes", () => {
    const cache = createCache();
    cache.begin("page", sessionKey, config).complete("Before topology change");
    sessionChanges.emit({ all: true, scope: "stores" });
    expect(cache.get("page", config)).toBeUndefined();
    cache.begin("page", sessionKey, config).complete("Before unknown transcript change");
    emitSessionTranscriptUpdate({ sessionFile: "/synthetic/unknown-session.jsonl" });
    expect(cache.get("page", config)).toBeUndefined();
  });

  it("keeps page/config variants separate and evicts least-recently-used content", () => {
    const cache = createCache();
    cache.begin("latest", sessionKey, config).complete("Latest");
    cache.begin("older", sessionKey, config).complete("Older");
    expect(cache.get("latest", config)?.body).toBe("Latest");
    expect(cache.get("older", {})?.body).toBeUndefined();
    for (let index = 0; index < 128; index++) {
      cache.begin(`page-${index}`, sessionKey, config).complete("Bounded");
    }
    expect(cache.get("latest", config)).toBeUndefined();
    expect(cache.get("page-127", config)?.body).toBe("Bounded");
  });

  it("bounds retained rendered bytes without changing the returned representation", () => {
    const cache = createCache();
    const body = "x".repeat(9 * 1024 * 1024);
    cache.begin("first", sessionKey, config).complete(body);
    const latest = cache.begin("second", sessionKey, config).complete(body);
    expect(latest?.body).toBe(body);
    expect(cache.get("first", config)).toBeUndefined();
    expect(cache.get("second", config)).toBe(latest);
    const tooLarge = cache.begin("large", sessionKey, config).complete(body + body);
    expect(tooLarge?.body).toHaveLength(body.length * 2);
    expect(cache.get("large", config)).toBeUndefined();
  });
});
