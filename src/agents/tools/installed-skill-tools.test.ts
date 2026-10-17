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

const guideMetadata = {
  name: "guide",
  description: "Operations",
  location: "/skills/guide/SKILL.md",
};

function skill(overrides: Partial<InstalledSkill> = {}): InstalledSkill {
  return {
    ...guideMetadata,
    source: { filePath: "/skills/guide/SKILL.md" },
    ...overrides,
  };
}

function admittedTools(skills: InstalledSkill[]) {
  const tools = createInstalledSkillTools(skills);
  finalizeAgentToolAvailability(tools);
  return { search: expectDefined(tools[0], "search"), read: expectDefined(tools[1], "read") };
}

function instructionContent(location: string, body: string) {
  return [
    {
      type: "text",
      text: `Skill location: ${location}\nResolve relative resource paths from the directory containing this SKILL.md.\n\n${body}`,
    },
  ];
}

it.each([
  "/skills/guide/SKILL.md",
  "workspace-skill://workspace/guide/SKILL.md",
  "C:\\skills\\guide\\SKILL.md",
  "\\\\server\\skills\\guide\\SKILL.md",
])("preserves the visible resource location on an exact-name read: %s", async (location) => {
  const body = "# Guide\n\nRead references/workflow.md before continuing.\n";
  const { read } = admittedTools([
    skill({
      location,
      source: { filePath: "/private/gateway/guide/SKILL.md", readContent: body },
    }),
  ]);
  const result = await read.execute("known-name", { name: "guide" });
  expect(result.content).toEqual(instructionContent(location, body));
  expect(result.details).toMatchObject({ name: "guide", location, content: body });
  expect(JSON.stringify(result)).not.toContain("/private/gateway");
});

it("requires the effective native read tool for body I/O and cached body matches", async () => {
  await withTempDir("installed-skill-authority-", async (dir) => {
    const filePath = path.join(dir, "SKILL.md");
    await writeFile(filePath, "Private canary deployment instructions");
    const reader = vi.fn(async (maxBytes: number) =>
      (await readLocalFileSafely({ filePath, maxBytes })).buffer.toString("utf8"),
    );
    const tools = createInstalledSkillTools([
      skill({ location: filePath, source: { filePath }, readSearchContent: reader }),
    ]);
    const search = expectDefined(tools[0], "search");
    const read = expectDefined(tools[1], "read");
    const find = async (id: string, query = "canary") =>
      (await search.execute(id, { query })).details;
    const check = async (id: string, names: string[], reads: number, query = "canary") => {
      expect(await find(id, query)).toMatchObject({ skills: names.map((name) => ({ name })) });
      expect(reader).toHaveBeenCalledTimes(reads);
    };
    finalizeAgentToolAvailability([search]);
    expect(await find("denied")).toMatchObject({
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
        ? "x".repeat(16 * 1024) + "\nUnabridged ending"
        : "# Guide\n\nUse a canary deployment.\nPreserve the complete rollback procedure.";
    const reader = vi.fn(async () => content);
    const entry = skill(
      mode === "reader"
        ? { reader, readSearchContent: reader }
        : { source: { filePath: guideMetadata.location, readContent: content } },
    );
    const unavailable = {
      name: "unavailable",
      description: "Operations",
      location: "/skills/unavailable/SKILL.md",
    };
    const catalog =
      mode === "partial"
        ? [
            entry,
            skill({
              ...unavailable,
              reader: async () => {
                throw new Error("Unavailable");
              },
            }),
          ]
        : [entry];
    const { search, read } = admittedTools(catalog);
    const result = await search.execute("find", {
      query: mode === "reader" ? "canary" : "operations",
    });
    expect(result.details).toEqual({
      skills: mode === "partial" ? [guideMetadata, unavailable] : [guideMetadata],
      hasMore: false,
      ...(mode === "partial"
        ? { coverage: { bodyIndexed: 1, metadataOnly: 1, truncatedBodies: 1 } }
        : {}),
    });
    if (mode === "reader") {
      expect(JSON.stringify(result)).not.toContain("rollback");
      await search.execute("cached-search", { query: "rollback" });
      expect(reader).toHaveBeenCalledTimes(1);
    } else if (mode === "inline") {
      await expect(read.execute("invalid", { name: "/etc/passwd" })).rejects.toThrow(
        "is not available to this agent",
      );
      expect(createInstalledSkillTools([])).toEqual([]);
    }
    expect((await read.execute("load", { name: "guide" })).content).toEqual(
      instructionContent(guideMetadata.location, content),
    );
    if (mode === "reader") {
      expect(reader).toHaveBeenLastCalledWith({
        location: guideMetadata.location,
        signal: undefined,
      });
      await expect(read.execute("invalid", { name: "../hidden" })).rejects.toThrow(
        "is not available to this agent",
      );
      expect(reader).toHaveBeenCalledTimes(2);
    }
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
