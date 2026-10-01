import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createInstalledSkillTools } from "./installed-skill-tools.js";

it("searches and reads through the model-facing tool contract without reading other paths", async () => {
  const tools = createInstalledSkillTools([
    {
      name: "release-guide",
      description: "Publish a software release",
      location: "/skills/release/SKILL.md",
      source: {
        filePath: "/skills/release/SKILL.md",
        readContent: "# Release\n\nCheck everything.\n",
      },
    },
  ]);
  const search = expectDefined(tools[0], "installed skill search tool");
  const read = expectDefined(tools[1], "installed skill read tool");
  expect((await search.execute("find", { query: "publish release" })).details).toEqual({
    skills: [
      {
        name: "release-guide",
        description: "Publish a software release",
        location: "/skills/release/SKILL.md",
      },
    ],
    hasMore: false,
  });
  expect((await read.execute("load", { name: "release-guide" })).content).toEqual([
    { type: "text", text: "# Release\n\nCheck everything.\n" },
  ]);
  await expect(read.execute("invalid", { name: "/etc/passwd" })).rejects.toThrow(
    "Unknown installed skill",
  );
  expect(createInstalledSkillTools([])).toEqual([]);
});

it("discovers a body-only capability through its reader without exposing instructions", async () => {
  const content =
    "# Release\n\nUse a canary deployment.\nPreserve the complete rollback procedure.";
  const reader = vi.fn(async () => content);
  const tools = createInstalledSkillTools([
    {
      name: "release-guide",
      description: "Publish a software release",
      location: "/skills/release/SKILL.md",
      source: { filePath: "/skills/release/SKILL.md" },
      reader,
      readSearchContent: reader,
    },
  ]);
  const search = expectDefined(tools[0], "search tool");
  const read = expectDefined(tools[1], "read tool");
  const first = await search.execute("body-search", { query: "canary" });
  expect(first.details).toEqual({
    skills: [
      {
        name: "release-guide",
        description: "Publish a software release",
        location: "/skills/release/SKILL.md",
      },
    ],
    hasMore: false,
  });
  expect(JSON.stringify(first)).not.toContain("rollback");
  await search.execute("cached-search", { query: "rollback" });
  expect(reader).toHaveBeenCalledTimes(1);
  expect((await read.execute("read", { name: "release-guide" })).content).toEqual([
    { type: "text", text: content },
  ]);
});

it("does not serve a cached body index after its owner loses authority", async () => {
  let current = true;
  const tools = createInstalledSkillTools([
    {
      name: "guide",
      description: "Operations",
      location: "/skills/guide/SKILL.md",
      source: { filePath: "/skills/guide/SKILL.md", readContent: "Canary deployment" },
      assertCurrent: () => {
        if (!current) {
          throw new Error("Run is no longer current");
        }
      },
    },
  ]);
  const search = expectDefined(tools[0], "search tool");
  await search.execute("first", { query: "canary" });
  current = false;
  await expect(search.execute("retained", { query: "canary" })).rejects.toThrow(
    "no longer current",
  );
});

it("reports unreadable and bounded bodies while preserving metadata search and whole reads", async () => {
  const large = `${"x".repeat(16 * 1024)}\nUnabridged ending`;
  const tools = createInstalledSkillTools([
    {
      name: "large",
      description: "Deployment guide",
      location: "/skills/large/SKILL.md",
      source: { filePath: "/skills/large/SKILL.md", readContent: large },
    },
    {
      name: "unavailable",
      description: "Deployment guide",
      location: "/skills/unavailable/SKILL.md",
      source: { filePath: "/skills/unavailable/SKILL.md" },
      reader: async () => {
        throw new Error("Unavailable");
      },
    },
  ]);
  const search = expectDefined(tools[0], "search tool");
  const read = expectDefined(tools[1], "read tool");
  expect((await search.execute("partial", { query: "deployment" })).details).toMatchObject({
    skills: [{ name: "large" }, { name: "unavailable" }],
    coverage: { bodyIndexed: 1, metadataOnly: 1, truncatedBodies: 1 },
  });
  expect((await read.execute("whole", { name: "large" })).content).toEqual([
    { type: "text", text: large },
  ]);
});

it("does not cache a cancelled read as an empty body", async () => {
  const controller = new AbortController();
  const reader = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
    if (signal === controller.signal) {
      controller.abort();
    }
    return "Canary deployment";
  });
  const tools = createInstalledSkillTools([
    {
      name: "guide",
      description: "Operations",
      location: "/skills/guide/SKILL.md",
      source: { filePath: "/skills/guide/SKILL.md" },
      reader,
      readSearchContent: (_maxBytes, signal) => reader({ signal }),
    },
  ]);
  const search = expectDefined(tools[0], "search tool");
  const cancelled = search.execute("cancelled", { query: "canary" }, controller.signal);
  const healthy = search.execute("healthy", { query: "canary" });
  await expect(cancelled).rejects.toThrow();
  expect((await healthy).details).toMatchObject({
    skills: [{ name: "guide" }],
  });
});

it("lets a waiting caller cancel without cancelling the cold index owner", async () => {
  const body = createDeferredCore<string>();
  const reader = vi.fn(() => body.promise);
  const tools = createInstalledSkillTools([
    {
      name: "guide",
      description: "Operations",
      location: "/skills/guide/SKILL.md",
      source: { filePath: "/skills/guide/SKILL.md" },
      reader,
      readSearchContent: reader,
    },
  ]);
  const search = expectDefined(tools[0], "search tool");
  const controller = new AbortController();
  const owner = search.execute("owner", { query: "canary" });
  const waiter = search.execute("waiter", { query: "canary" }, controller.signal);
  const cancelled = expect(waiter).rejects.toThrow();
  controller.abort();
  try {
    await cancelled;
  } finally {
    body.resolve("Canary deployment");
    await owner;
  }
  expect((await owner).details).toMatchObject({ skills: [{ name: "guide" }] });
  expect(reader).toHaveBeenCalledOnce();
});

it("bounds concurrent cold searches and retains metadata outside the body budget", async () => {
  let active = 0;
  let peak = 0;
  const reader = vi.fn(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    return "Canary";
  });
  const tools = createInstalledSkillTools(
    Array.from({ length: 1_025 }, (_, index) => ({
      name: `guide-${String(index).padStart(4, "0")}`,
      description: "Deployment",
      location: `/skills/guide-${index}/SKILL.md`,
      source: { filePath: `/skills/guide-${index}/SKILL.md` },
      reader,
      readSearchContent: reader,
    })).toReversed(),
  );
  const search = expectDefined(tools[0], "search tool");
  const [result] = await Promise.all([
    search.execute("budget", { query: "guide-1024", limit: 1 }),
    search.execute("concurrent", { query: "canary" }),
  ]);
  expect(result.details).toMatchObject({
    skills: [{ name: "guide-1024" }],
    coverage: { bodyIndexed: 1_024, metadataOnly: 1, truncatedBodies: 0 },
  });
  expect(peak).toBeLessThanOrEqual(4);
  expect(reader).toHaveBeenCalledTimes(1_024);
});
