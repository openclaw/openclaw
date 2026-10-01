import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { readLocalFileSafely } from "../../infra/fs-safe.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import {
  finalizeAgentToolAvailability,
  markAgentToolExecutionUnavailable,
} from "../agent-tool-availability.js";
import { createInstalledSkillTools } from "./installed-skill-tools.js";

it("requires the effective native read tool for body I/O and cached body matches", async () => {
  await withTempDir("installed-skill-authority-", async (dir) => {
    const filePath = path.join(dir, "SKILL.md");
    await writeFile(filePath, "Private canary deployment instructions");
    let reads = 0;
    const tools = createInstalledSkillTools([
      {
        name: "guide",
        description: "Operations",
        location: filePath,
        source: { filePath },
        readSearchContent: async (maxBytes) => {
          reads += 1;
          return (await readLocalFileSafely({ filePath, maxBytes })).buffer.toString("utf8");
        },
      },
    ]);
    const search = expectDefined(tools[0], "search");
    const read = expectDefined(tools[1], "read");
    finalizeAgentToolAvailability([search]);
    expect((await search.execute("denied", { query: "canary" })).details).toMatchObject({
      skills: [],
      coverage: { bodyIndexed: 0, metadataOnly: 1 },
    });
    expect((await search.execute("metadata", { query: "operations" })).details).toMatchObject({
      skills: [{ name: "guide" }],
    });
    expect(reads).toBe(0);
    finalizeAgentToolAvailability(tools);
    expect((await search.execute("allowed", { query: "canary" })).details).toMatchObject({
      skills: [{ name: "guide" }],
    });
    expect(reads).toBe(1);
    finalizeAgentToolAvailability(tools, { toolExecutionAllow: ["skills_search"] });
    expect((await search.execute("revoked", { query: "canary" })).details).toMatchObject({
      skills: [],
    });
    finalizeAgentToolAvailability([search, { ...read }]);
    expect((await search.execute("shadowed", { query: "canary" })).details).toMatchObject({
      skills: [],
    });
    markAgentToolExecutionUnavailable(read);
    finalizeAgentToolAvailability(tools);
    expect((await search.execute("execution-denied", { query: "canary" })).details).toMatchObject({
      skills: [],
    });
    expect(reads).toBe(1);
  });
});

it("does not publish an in-flight body index across read revocation and regrant", async () => {
  const body = createDeferredCore<string>();
  const reader = vi.fn(() => body.promise);
  const tools = createInstalledSkillTools([
    {
      name: "guide",
      description: "Operations",
      location: "/skills/guide/SKILL.md",
      source: { filePath: "/skills/guide/SKILL.md" },
      readSearchContent: reader,
    },
  ]);
  const search = expectDefined(tools[0], "search");
  finalizeAgentToolAvailability(tools);
  const pending = search.execute("in-flight", { query: "canary" });
  const rejected = expect(pending).rejects.toThrow("permission changed");
  finalizeAgentToolAvailability([search]);
  finalizeAgentToolAvailability(tools);
  body.resolve("Canary deployment");
  await rejected;
  expect((await search.execute("regranted", { query: "canary" })).details).toMatchObject({
    skills: [{ name: "guide" }],
  });
  expect(reader).toHaveBeenCalledTimes(2);
});

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
  finalizeAgentToolAvailability(tools);
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
  finalizeAgentToolAvailability(tools);
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
  finalizeAgentToolAvailability(tools);
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
  finalizeAgentToolAvailability(tools);
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
  finalizeAgentToolAvailability(tools);
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
  finalizeAgentToolAvailability(tools);
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
  finalizeAgentToolAvailability(tools);
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
