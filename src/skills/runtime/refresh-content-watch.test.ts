import { EventEmitter } from "node:events";
import { ok, err, type Result } from "@openclaw/normalization-core/result";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createSkillsContentWatcher } from "./refresh-content-watch.js";
import type { SkillsDirectoryWatcher } from "./refresh-watch-types.js";

it("rejects a pending verifier dirtied without an admitted raw filename", async () => {
  const transports: Array<EventEmitter & SkillsDirectoryWatcher> = [];
  const ready = vi.fn();
  const owner = createSkillsContentWatcher({
    watch: () => {
      const transport = Object.assign(new EventEmitter(), {
        closed: false,
        directories: new Set(["skills"]),
        close: vi.fn(() => {
          transport.closed = true;
          return Promise.resolve(ok(undefined));
        }),
      });
      transports.push(transport);
      return transport;
    },
    isCurrent: () => true,
    isStructuralRaw: () => false,
    ready,
    changed: vi.fn(),
    raw: vi.fn(),
    error: vi.fn(),
  });
  try {
    const active = transports[0]!;
    active.emit("ready");
    const stale = transports[1]!;
    active.emit("dirty");
    stale.emit("ready");
    expect(ready).not.toHaveBeenCalled();
    expect(active.closed).toBe(false);
    expect(stale.closed).toBe(true);
    expect(transports).toHaveLength(3);
    // Retired delivery must not dirty the replacement verifier.
    stale.emit("dirty");
    transports[2]!.emit("ready");
    expect(ready).toHaveBeenCalledOnce();
    expect(active.closed).toBe(true);
    expect(await owner.close()).toEqual(ok(undefined));
    for (const transport of transports) {
      transport.emit("dirty");
    }
    expect(transports).toHaveLength(3);
    expect(transports.every(({ closed }) => closed)).toBe(true);
  } finally {
    await owner.close();
  }
});

it.each(["pending", "failed"] as const)(
  "includes a previously retired generation's %s close in owner retirement",
  async (outcome) => {
    const retirement = createDeferredCore<Result<void, unknown>>();
    const failure = new Error("previous generation failed to retire");
    const transports: Array<EventEmitter & SkillsDirectoryWatcher> = [];
    const changed = vi.fn();
    const ready = vi.fn();
    const owner = createSkillsContentWatcher({
      watch: () => {
        const events = new EventEmitter();
        const first = transports.length === 0;
        const transport = Object.assign(events, {
          closed: false,
          directories: new Set(["skills"]),
          close: vi.fn(() => {
            transport.closed = true;
            return first ? retirement.promise : Promise.resolve(ok(undefined));
          }),
        });
        transports.push(transport);
        return transport;
      },
      isCurrent: () => true,
      isStructuralRaw: () => false,
      ready,
      changed,
      raw: vi.fn(),
      error: vi.fn(),
    });
    try {
      transports[0]!.emit("ready");
      transports[1]!.emit("ready");
      expect(ready).toHaveBeenCalledOnce();
      expect(transports[0]!.closed).toBe(true);
      if (outcome === "failed") {
        retirement.resolve(err(failure));
        await retirement.promise;
      }
      let settled = false;
      const closing = owner.close();
      void closing.then(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (outcome === "pending") {
        expect(settled).toBe(false);
        retirement.resolve(ok(undefined));
      }
      expect(await closing).toEqual(outcome === "pending" ? ok(undefined) : err(failure));
      expect(owner.close()).toBe(closing);
      for (const transport of transports) {
        transport.emit("all", "change", "skills/SKILL.md");
        transport.emit("ready");
      }
      expect(changed).not.toHaveBeenCalled();
      expect(ready).toHaveBeenCalledOnce();
    } finally {
      retirement.resolve(ok(undefined));
      await owner.close();
    }
  },
);
