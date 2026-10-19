import { afterEach, describe, expect, it } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createPublicSessionRepresentationCache } from "./control-ui-public-session-cache.js";

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
    const result = cache.begin("page", sessionKey).complete("Published text");
    expect(cache.get("page")).toBe(result);
    sessionChanges.emit({ sessionKey: "agent:main:other" });
    expect(cache.get("page")).toBe(result);
    emitSessionTranscriptUpdate({ sessionKey, sessionId: "generation", agentId: "main" });
    expect(cache.get("page")).toBeUndefined();
    cache.begin("page", sessionKey).complete("Revised text");
    sessionChanges.emit({ sessionKey });
    expect(cache.get("page")).toBeUndefined();
  });

  it("cannot restore content from work that crossed revocation, rewrite, or shutdown", () => {
    const cache = createCache();
    const pending = cache.begin("page", sessionKey);
    sessionChanges.emit({ sessionKey });
    const replacement = cache.begin("page", sessionKey).complete("Replacement");
    expect(pending.complete("Must not return")).toBeUndefined();
    pending.cancel();
    expect(cache.get("page")).toBe(replacement);
    const closing = cache.begin("next", sessionKey);
    cache.dispose();
    expect(closing.complete("Must not return")).toBeUndefined();
    expect(cache.get("page")).toBeUndefined();
  });

  it("invalidates all representations for topology and unresolved transcript changes", () => {
    const cache = createCache();
    cache.begin("page", sessionKey).complete("Before topology change");
    sessionChanges.emit({ all: true, scope: "stores" });
    expect(cache.get("page")).toBeUndefined();
    cache.begin("page", sessionKey).complete("Before unknown transcript change");
    emitSessionTranscriptUpdate({ sessionFile: "/synthetic/unknown-session.jsonl" });
    expect(cache.get("page")).toBeUndefined();
  });

  it("keeps page variants separate and evicts least-recently-used content", () => {
    const cache = createCache();
    cache.begin("latest", sessionKey).complete("Latest");
    cache.begin("older", sessionKey).complete("Older");
    expect(cache.get("latest")?.body).toBe("Latest");
    expect(cache.get("older")?.body).toBe("Older");
    for (let index = 0; index < 128; index++) {
      cache.begin(`page-${index}`, sessionKey).complete("Bounded");
    }
    expect(cache.get("latest")).toBeUndefined();
    expect(cache.get("page-127")?.body).toBe("Bounded");
  });

  it("bounds retained rendered bytes without changing the returned representation", () => {
    const cache = createCache();
    const body = "x".repeat(9 * 1024 * 1024);
    cache.begin("first", sessionKey).complete(body);
    const latest = cache.begin("second", sessionKey).complete(body);
    expect(latest?.body).toBe(body);
    expect(cache.get("first")).toBeUndefined();
    expect(cache.get("second")).toBe(latest);
    const tooLarge = cache.begin("large", sessionKey).complete(body + body);
    expect(tooLarge?.body).toHaveLength(body.length * 2);
    expect(cache.get("large")).toBeUndefined();
  });
});
