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
    const result = cache.begin("page", sessionKey, config, "transcript").complete("Published text");
    expect(cache.get("page", config)).toBe(result);
    sessionChanges.emit({ sessionKey: "agent:main:other" });
    expect(cache.get("page", config)).toBe(result);
    emitSessionTranscriptUpdate({ sessionKey, sessionId: "generation", agentId: "main" });
    expect(cache.get("page", config)).toBeUndefined();
    cache.begin("page", sessionKey, config, "transcript").complete("Revised text");
    sessionChanges.emit({ sessionKey });
    expect(cache.get("page", config)).toBeUndefined();
  });

  it("cannot restore content from work that crossed revocation, rewrite, or shutdown", () => {
    const cache = createCache();
    const pending = cache.begin("page", sessionKey, config, "transcript");
    sessionChanges.emit({ sessionKey });
    const replacement = cache
      .begin("page", sessionKey, config, "transcript")
      .complete("Replacement");
    expect(pending.complete("Must not return")).toBeUndefined();
    pending.cancel();
    expect(cache.get("page", config)).toBe(replacement);
    const closing = cache.begin("next", sessionKey, config, "transcript");
    cache.dispose();
    expect(closing.complete("Must not return")).toBeUndefined();
    expect(cache.get("page", config)).toBeUndefined();
  });

  it("invalidates all representations for topology and unresolved transcript changes", () => {
    const cache = createCache();
    cache.begin("page", sessionKey, config, "transcript").complete("Before topology change");
    sessionChanges.emit({ all: true, scope: "stores" });
    expect(cache.get("page", config)).toBeUndefined();
    cache
      .begin("page", sessionKey, config, "transcript")
      .complete("Before unknown transcript change");
    emitSessionTranscriptUpdate({ sessionFile: "/synthetic/unknown-session.jsonl" });
    expect(cache.get("page", config)).toBeUndefined();
  });

  it("keeps page/config variants separate and evicts least-recently-used content", () => {
    const cache = createCache();
    cache.begin("latest", sessionKey, config, "transcript").complete("Latest");
    cache.begin("older", sessionKey, config, "transcript").complete("Older");
    expect(cache.get("latest", config)?.body).toBe("Latest");
    expect(cache.get("older", {})?.body).toBeUndefined();
    for (let index = 0; index < 128; index++) {
      cache.begin(`page-${index}`, sessionKey, config, "transcript").complete("Bounded");
    }
    expect(cache.get("latest", config)).toBeUndefined();
    expect(cache.get("page-127", config)?.body).toBe("Bounded");
  });

  it("bounds retained rendered bytes without changing the returned representation", () => {
    const cache = createCache();
    const body = "x".repeat(9 * 1024 * 1024);
    cache.begin("first", sessionKey, config, "transcript").complete(body);
    const latest = cache.begin("second", sessionKey, config, "transcript").complete(body);
    expect(latest?.body).toBe(body);
    expect(cache.get("first", config)).toBeUndefined();
    expect(cache.get("second", config)).toBe(latest);
    const tooLarge = cache.begin("large", sessionKey, config, "transcript").complete(body + body);
    expect(tooLarge?.body).toHaveLength(body.length * 2);
    expect(cache.get("large", config)).toBeUndefined();
  });
  it.each(["runtime", "agent-runs", "subagent-runs"] as const)(
    "only invalidates live cards for %s changes",
    (scope) => {
      const cache = createCache();
      const transcript = cache
        .begin("page", sessionKey, config, "transcript")
        .complete("Published");
      const card = cache.begin("card", sessionKey, config, "card").complete("Live");
      sessionChanges.emit({ all: true, scope });
      expect(cache.get("page", config)).toBe(transcript);
      expect(transcript?.isCurrent()).toBe(true);
      expect(cache.get("card", config)).toBeUndefined();
      expect(card?.isCurrent()).toBe(false);
      sessionChanges.emit({ sessionKey });
      expect(transcript?.isCurrent()).toBe(false);
    },
  );
});
