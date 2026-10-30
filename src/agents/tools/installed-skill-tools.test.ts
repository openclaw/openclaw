import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  finalizeAgentToolAvailability,
  markAgentToolExecutionUnavailable,
} from "../agent-tool-availability.js";
import type { InstalledSkill } from "../installed-skill-catalog.js";
import { createInstalledSkillTools } from "./installed-skill-tools.js";

const guideMetadata = {
  name: "guide",
  description: "Operations",
  location: "/skills/guide/SKILL.md",
};

function skill(overrides: Partial<InstalledSkill> = {}): InstalledSkill {
  return { ...guideMetadata, source: { filePath: guideMetadata.location }, ...overrides };
}

function skillTools(skills: InstalledSkill[]) {
  const tools = createInstalledSkillTools(skills);
  finalizeAgentToolAvailability(tools);
  const search = expectDefined(tools[0], "search");
  const read = expectDefined(tools[1], "read");
  return {
    tools,
    search,
    read,
    find: (id: string, query = "canary", signal?: AbortSignal) =>
      search.execute(id, { query }, signal),
    load: (id: string, name = "guide") => read.execute(id, { name }),
  };
}
it("requires the effective native read tool for body I/O and cached body matches", async () => {
  const reader = vi.fn(async () => "Private canary deployment instructions");
  const { tools, search, read, find } = skillTools([skill({ readSearchContent: reader })]);
  const check = async (id: string, names: string[], reads: number, query = "canary") => {
    const skills = names.map((name) => ({ name }));
    expect((await find(id, query)).details).toMatchObject({ skills });
    expect(reader).toHaveBeenCalledTimes(reads);
  };
  finalizeAgentToolAvailability([search]);
  expect((await find("denied")).details).toMatchObject({
    skills: [],
    coverage: { bodyIndexed: 0, metadataOnly: 1 },
  });
  await check("metadata", ["guide"], 0, "operations");
  finalizeAgentToolAvailability(tools);
  await check("allowed", ["guide"], 1);
  finalizeAgentToolAvailability(tools, { toolExecutionAllow: ["skills_search"] });
  await check("revoked", [], 1);
  finalizeAgentToolAvailability([search, { ...read }]);
  await check("shadowed", [], 1);
  markAgentToolExecutionUnavailable(read);
  finalizeAgentToolAvailability(tools);
  await check("execution-denied", [], 1);
});
it("does not publish an in-flight body index across read revocation and regrant", async () => {
  const body = createDeferredCore<string>();
  const reader = vi.fn(() => body.promise);
  const { tools, search, find } = skillTools([skill({ readSearchContent: reader })]);
  const pending = find("in-flight");
  const rejected = expect(pending).rejects.toThrow("permission changed");
  finalizeAgentToolAvailability([search]);
  finalizeAgentToolAvailability(tools);
  body.resolve("Canary deployment");
  await rejected;
  expect((await find("regranted")).details).toMatchObject({
    skills: [{ name: "guide" }],
  });
  expect(reader).toHaveBeenCalledTimes(2);
});

it.each([
  ["inline", "/skills/guide/SKILL.md"],
  ["reader", "/skills/guide/SKILL.md"],
  ["partial", "/skills/guide/SKILL.md"],
] as const)("searches and reads whole %s instructions at %s", async (mode, location) => {
  const name = mode === "reader" ? "release-guide" : "guide";
  const content =
    mode === "partial"
      ? "x".repeat(16 * 1024) + "\nUnabridged ending"
      : "# Guide\n\nUse a canary deployment.\nPreserve the complete rollback procedure.";
  const reader = vi.fn(async () => content);
  const source = { filePath: "/private/gateway/guide/SKILL.md" };
  const entry = skill({
    name,
    location,
    source: mode === "reader" ? source : { ...source, readContent: content },
    ...(mode === "reader" ? { reader, readSearchContent: reader } : {}),
  });
  const unreadable = skill({
    name: "unavailable",
    async reader() {
      throw new Error("Unavailable");
    },
  });
  const { find, load } = skillTools(mode === "partial" ? [entry, unreadable] : [entry]);
  const result = await find("find", mode === "reader" ? "canary" : "operations");
  expect(result.details).toEqual({
    skills: [
      { ...guideMetadata, name, location },
      ...(mode === "partial" ? [{ ...guideMetadata, name: "unavailable" }] : []),
    ],
    hasMore: false,
    ...(mode === "partial"
      ? { coverage: { bodyIndexed: 1, metadataOnly: 1, truncatedBodies: 1 } }
      : {}),
  });
  if (mode === "reader") {
    expect(JSON.stringify(result)).not.toContain("rollback");
    await find("cached-search", "rollback");
    expect(reader).toHaveBeenCalledTimes(1);
  } else if (mode === "inline") {
    await expect(load("invalid", "/etc/passwd")).rejects.toThrow("is not available to this agent");
    expect(createInstalledSkillTools([])).toEqual([]);
  }
  const loaded = await load("load", name);
  const text = `Skill location: ${location}\nResolve relative resource paths from the directory containing this SKILL.md.\n\n${content}`;
  expect(loaded.content).toEqual([{ type: "text", text }]);
  expect(loaded.details).toMatchObject({ name, location, content });
  expect(JSON.stringify(loaded)).not.toContain("/private/gateway");
  if (mode === "reader") {
    expect(reader).toHaveBeenCalledTimes(2);
  }
});
it("does not serve a cached body index after its owner loses authority", async () => {
  let current = true;
  const { find } = skillTools([
    skill({
      source: { filePath: "/skills/guide/SKILL.md", readContent: "Canary deployment" },
      assertCurrent: () => {
        if (!current) {
          throw new Error("Run is no longer current");
        }
      },
    }),
  ]);
  await find("first");
  current = false;
  await expect(find("retained")).rejects.toThrow("no longer current");
});

it.each(["owner", "waiter"] as const)(
  "cancels the index %s without poisoning the other caller",
  async (cancelled) => {
    const body = createDeferredCore<string>();
    const controller = new AbortController();
    const reader = vi.fn(async (_maxBytes: number, signal?: AbortSignal) => {
      if (cancelled === "owner" && signal === controller.signal) {
        controller.abort();
      }
      return body.promise;
    });
    const { find } = skillTools([skill({ readSearchContent: reader })]);
    const owner = find("owner", "canary", cancelled === "owner" ? controller.signal : undefined);
    const waiter = find("waiter", "canary", cancelled === "waiter" ? controller.signal : undefined);
    const rejected = expect(cancelled === "owner" ? owner : waiter).rejects.toThrow();
    if (cancelled === "waiter") {
      controller.abort();
      try {
        await rejected;
      } finally {
        body.resolve("Canary deployment");
        await owner;
      }
      expect(reader).toHaveBeenCalledOnce();
    } else {
      body.resolve("Canary deployment");
      await rejected;
    }
    expect((await (cancelled === "owner" ? waiter : owner)).details).toMatchObject({
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
  const { search } = skillTools(
    Array.from({ length: 1_025 }, (_, index) =>
      skill({
        name: `guide-${String(index).padStart(4, "0")}`,
        location: `/skills/guide-${index}/SKILL.md`,
        readSearchContent: reader,
      }),
    ).toReversed(),
  );
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
