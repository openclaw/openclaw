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
import type { InstalledSkill } from "../installed-skill-catalog.js";
import { createInstalledSkillTools } from "./installed-skill-tools.js";

function skill(overrides: Partial<InstalledSkill> = {}): InstalledSkill {
  return {
    name: "guide",
    description: "Operations",
    location: "/skills/guide/SKILL.md",
    source: { filePath: "/skills/guide/SKILL.md" },
    ...overrides,
  };
}

function admittedTools(skills: InstalledSkill[]) {
  const tools = createInstalledSkillTools(skills);
  finalizeAgentToolAvailability(tools);
  return { search: expectDefined(tools[0], "search"), read: expectDefined(tools[1], "read") };
}

it("requires the effective native read tool for body I/O and cached body matches", async () => {
  await withTempDir("installed-skill-authority-", async (dir) => {
    const filePath = path.join(dir, "SKILL.md");
    await writeFile(filePath, "Private canary deployment instructions");
    let reads = 0;
    const tools = createInstalledSkillTools([
      skill({
        location: filePath,
        source: { filePath },
        readSearchContent: async (maxBytes) => {
          reads += 1;
          return (await readLocalFileSafely({ filePath, maxBytes })).buffer.toString("utf8");
        },
      }),
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
  const tools = createInstalledSkillTools([skill({ readSearchContent: reader })]);
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

it.each(["inline", "reader", "partial"] as const)(
  "searches metadata and reads whole instructions from %s content",
  async (mode) => {
    const content =
      mode === "partial"
        ? `${"x".repeat(16 * 1024)}\nUnabridged ending`
        : mode === "reader"
          ? "# Release\n\nUse a canary deployment.\nPreserve the complete rollback procedure."
          : "# Release\n\nCheck everything.\n";
    const reader = vi.fn(async () => content);
    const entry = skill({
      name: mode === "partial" ? "large" : "release-guide",
      description: mode === "partial" ? "Deployment guide" : "Publish a software release",
      location: mode === "partial" ? "/skills/large/SKILL.md" : "/skills/release/SKILL.md",
      source: {
        filePath: mode === "partial" ? "/skills/large/SKILL.md" : "/skills/release/SKILL.md",
        ...(mode === "reader" ? {} : { readContent: content }),
      },
      ...(mode === "reader" ? { reader, readSearchContent: reader } : {}),
    });
    const unavailable = skill({
      name: "unavailable",
      description: "Deployment guide",
      location: "/skills/unavailable/SKILL.md",
      source: { filePath: "/skills/unavailable/SKILL.md" },
      reader: async () => {
        throw new Error("Unavailable");
      },
    });
    const { search, read } = admittedTools(mode === "partial" ? [entry, unavailable] : [entry]);
    const result = await search.execute("find", {
      query: mode === "partial" ? "deployment" : mode === "reader" ? "canary" : "publish release",
    });
    if (mode === "partial") {
      expect(result.details).toMatchObject({
        skills: [{ name: "large" }, { name: "unavailable" }],
        coverage: { bodyIndexed: 1, metadataOnly: 1, truncatedBodies: 1 },
      });
    } else {
      expect(result.details).toEqual({
        skills: [
          {
            name: "release-guide",
            description: "Publish a software release",
            location: "/skills/release/SKILL.md",
          },
        ],
        hasMore: false,
      });
      if (mode === "reader") {
        expect(JSON.stringify(result)).not.toContain("rollback");
        await search.execute("cached-search", { query: "rollback" });
        expect(reader).toHaveBeenCalledTimes(1);
      } else {
        await expect(read.execute("invalid", { name: "/etc/passwd" })).rejects.toThrow(
          "Unknown installed skill",
        );
        expect(createInstalledSkillTools([])).toEqual([]);
      }
    }
    expect((await read.execute("load", { name: entry.name })).content).toEqual([
      { type: "text", text: content },
    ]);
  },
);

it("does not serve a cached body index after its owner loses authority", async () => {
  let current = true;
  const { search } = admittedTools([
    skill({
      source: { filePath: "/skills/guide/SKILL.md", readContent: "Canary deployment" },
      assertCurrent: () => {
        if (!current) {
          throw new Error("Run is no longer current");
        }
      },
    }),
  ]);
  await search.execute("first", { query: "canary" });
  current = false;
  await expect(search.execute("retained", { query: "canary" })).rejects.toThrow(
    "no longer current",
  );
});

it.each(["owner", "waiter"] as const)(
  "cancels the index %s without poisoning the other caller",
  async (cancelledCaller) => {
    const body = createDeferredCore<string>();
    const controller = new AbortController();
    const reader = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      if (cancelledCaller === "owner" && signal === controller.signal) {
        controller.abort();
      }
      return body.promise;
    });
    const { search } = admittedTools([
      skill({
        reader,
        readSearchContent: (_maxBytes, signal) => reader({ signal }),
      }),
    ]);
    const owner = search.execute(
      "owner",
      { query: "canary" },
      cancelledCaller === "owner" ? controller.signal : undefined,
    );
    const waiter = search.execute(
      "waiter",
      { query: "canary" },
      cancelledCaller === "waiter" ? controller.signal : undefined,
    );
    const cancelled = expect(cancelledCaller === "owner" ? owner : waiter).rejects.toThrow();
    if (cancelledCaller === "waiter") {
      controller.abort();
      try {
        await cancelled;
      } finally {
        body.resolve("Canary deployment");
        await owner;
      }
      expect(reader).toHaveBeenCalledOnce();
    } else {
      body.resolve("Canary deployment");
      await cancelled;
    }
    expect((await (cancelledCaller === "owner" ? waiter : owner)).details).toMatchObject({
      skills: [{ name: "guide" }],
    });
  },
);

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
