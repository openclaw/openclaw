import { afterEach, describe, expect, it, vi } from "vitest";
import * as pinPolicy from "../config/sessions/session-pin-policy.js";
import {
  compareSessionEntryPairs,
  mergeSessionEntryPages,
  sortAndLimitSessionEntries,
  type SessionEntryPair,
} from "./session-list-order.js";

afterEach(() => vi.restoreAllMocks());

function entries(): SessionEntryPair[] {
  return Array.from({ length: 513 }, (_, i) => [
    `agent:main:${i % 4 === 0 ? "subagent" : "dashboard"}:${i % 509}`,
    {
      sessionId: `session-${i}`,
      updatedAt: (i * 37) % 23,
      createdAt: i % 11,
      markedUnreadAt: i % 3 === 0 ? 1 : undefined,
      lastActivityAt: i % 3 === 0 ? i % 17 : undefined,
      lastInteractionAt: i % 5 === 0 ? i % 19 : undefined,
      pinnedAt: i % 7 === 0 ? i % 13 : undefined,
      parentSessionKey: i % 3 === 0 ? "agent:main:main" : "agent:main:dashboard:parent",
      spawnedBy: i % 9 === 0 ? "agent:main:main" : undefined,
      sidebarRoot: i % 11 === 0,
    },
  ]);
}

describe("sortAndLimitSessionEntries", () => {
  it.each([undefined, "updatedAt", "lastInteractionAt", "activity", "unread"] as const)(
    "preserves the existing comparator's ordering for %s",
    (sortBy) => {
      const random = entries();
      const ascending = random.toSorted((a, b) => compareSessionEntryPairs(a, b, sortBy));
      for (const input of [random, ascending, ascending.toReversed(), [], random.slice(0, 1)]) {
        const original = [...input];
        const expected = input.toSorted((a, b) => compareSessionEntryPairs(a, b, sortBy));
        for (const limit of [0, 1, 20, 100, 200, 201, 1000, undefined]) {
          const selected = sortAndLimitSessionEntries(input, limit, sortBy);
          expect(selected).toEqual(limit === undefined ? expected : expected.slice(0, limit));
          selected.forEach((entry) => expect(input).toContain(entry));
          expect(input).toEqual(original);
        }
      }
    },
  );

  it("checks pin eligibility once per pinned entry in each sort, including after edits", () => {
    const input = entries();
    const expected = input.toSorted(compareSessionEntryPairs).slice(0, 100);
    const eligibility = vi.spyOn(pinPolicy, "isPinnableSessionEntry");
    expect(sortAndLimitSessionEntries(input, 100, undefined)).toEqual(expected);
    expect(eligibility).toHaveBeenCalledTimes(
      input.filter(([, entry]) => entry.pinnedAt !== undefined).length,
    );

    input[1]![1].pinnedAt = 1000;
    input[1]![1].sidebarRoot = true;
    const updated = input.toSorted(compareSessionEntryPairs).slice(0, 100);
    eligibility.mockClear();
    expect(sortAndLimitSessionEntries(input, 100, undefined)).toEqual(updated);
    expect(eligibility).toHaveBeenCalledTimes(
      input.filter(([, entry]) => entry.pinnedAt !== undefined).length,
    );
  });

  it("reads each activity sort key once rather than once per comparison", () => {
    let reads = 0;
    const input = entries();
    for (const [, entry] of input) {
      const value = entry.lastActivityAt;
      Object.defineProperty(entry, "lastActivityAt", {
        get() {
          reads++;
          return value;
        },
      });
    }
    const expected = input
      .toSorted((a, b) => compareSessionEntryPairs(a, b, "activity"))
      .slice(0, 200);
    reads = 0;
    expect(sortAndLimitSessionEntries(input, 200, "activity")).toEqual(expected);
    expect(reads).toBe(input.length);
  });

  it("matches the ordering contract over randomized timestamps, ties, pins, and missing clocks", () => {
    let seed = 225;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let trial = 0; trial < 16; trial++) {
      const input: SessionEntryPair[] = Array.from({ length: 257 }, (_, index) => {
        const clock = () =>
          random() % 7 === 0 ? undefined : 1_790_000_000_000 + (random() % 5) * 86_400_000;
        const kind = random() % 3 === 0 ? "subagent" : "dashboard";
        return [
          `agent:main:${kind}:${random() % 31}`,
          {
            sessionId: `random-${trial}-${index}`,
            updatedAt: clock() ?? 0,
            createdAt: clock(),
            markedUnreadAt: random() % 3 === 0 ? 1 : undefined,
            lastActivityAt: clock(),
            lastInteractionAt: clock(),
            pinnedAt: clock(),
            sidebarRoot: random() % 5 === 0,
            spawnedBy: random() % 5 === 0 ? "agent:main:main" : undefined,
            parentSessionKey:
              random() % 2 === 0 ? "agent:main:main" : "agent:main:dashboard:parent",
          },
        ];
      });
      for (const sortBy of ["updatedAt", "activity", "lastInteractionAt", "unread"] as const) {
        const expected = input.toSorted((a, b) => compareSessionEntryPairs(a, b, sortBy));
        for (const limit of [1, 200, 201, undefined]) {
          expect(sortAndLimitSessionEntries(input, limit, sortBy)).toEqual(
            limit === undefined ? expected : expected.slice(0, limit),
          );
        }
      }
    }
  });
});

it("ranks unread first without pin priority across partition pages", () => {
  const input: SessionEntryPair[] = [
    ["read-new", { sessionId: "read-new", updatedAt: 100 }],
    ["unread-old", { sessionId: "unread-old", updatedAt: 1, markedUnreadAt: 1 }],
    ["pinned-read", { sessionId: "pinned-read", updatedAt: 50, pinnedAt: 200 }],
    ["unread-new", { sessionId: "unread-new", updatedAt: 10, markedUnreadAt: 1 }],
  ];
  const expected = ["unread-new", "unread-old", "read-new", "pinned-read"];
  expect(sortAndLimitSessionEntries(input, undefined, "unread").map(([key]) => key)).toEqual(
    expected,
  );
  const pages = [input.slice(0, 2), input.slice(2)].map((page) =>
    sortAndLimitSessionEntries(page, undefined, "unread"),
  );
  expect(mergeSessionEntryPages(pages, 3, "unread").map(([key]) => key)).toEqual(
    expected.slice(0, 3),
  );
});
