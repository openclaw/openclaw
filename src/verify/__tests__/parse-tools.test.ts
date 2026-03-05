import * as path from "path";
import { describe, it, expect } from "vitest";
import { parsePipeline } from "../parse-pipeline.js";
import { parsePolicies } from "../parse-policies.js";
import { parseToolCatalog } from "../parse-tools.js";

const srcDir = path.resolve(import.meta.dirname ?? __dirname, "../../..");

describe("parseToolCatalog", () => {
  const catalog = parseToolCatalog(path.join(srcDir, "src"));

  it("parses all 25 tool definitions", () => {
    expect(catalog.tools.length).toBe(25);
  });

  it("extracts all tool ids", () => {
    const ids = catalog.tools.map((t) => t.id).toSorted();
    expect(ids).toEqual([
      "agents_list",
      "apply_patch",
      "browser",
      "canvas",
      "cron",
      "edit",
      "exec",
      "gateway",
      "image",
      "memory_get",
      "memory_search",
      "message",
      "nodes",
      "process",
      "read",
      "session_status",
      "sessions_history",
      "sessions_list",
      "sessions_send",
      "sessions_spawn",
      "subagents",
      "tts",
      "web_fetch",
      "web_search",
      "write",
    ]);
  });

  it("assigns correct section for every tool", () => {
    const byId = Object.fromEntries(catalog.tools.map((t) => [t.id, t.sectionId]));
    expect(byId).toEqual({
      read: "fs",
      write: "fs",
      edit: "fs",
      apply_patch: "fs",
      exec: "runtime",
      process: "runtime",
      web_search: "web",
      web_fetch: "web",
      memory_search: "memory",
      memory_get: "memory",
      sessions_list: "sessions",
      sessions_history: "sessions",
      sessions_send: "sessions",
      sessions_spawn: "sessions",
      subagents: "sessions",
      session_status: "sessions",
      browser: "ui",
      canvas: "ui",
      message: "messaging",
      cron: "automation",
      gateway: "automation",
      nodes: "nodes",
      agents_list: "agents",
      image: "media",
      tts: "media",
    });
  });

  it("assigns correct profiles for every tool", () => {
    const byId = Object.fromEntries(catalog.tools.map((t) => [t.id, t.profiles]));
    expect(byId).toEqual({
      read: ["coding"],
      write: ["coding"],
      edit: ["coding"],
      apply_patch: ["coding"],
      exec: ["coding"],
      process: ["coding"],
      web_search: [],
      web_fetch: [],
      memory_search: ["coding"],
      memory_get: ["coding"],
      sessions_list: ["coding", "messaging"],
      sessions_history: ["coding", "messaging"],
      sessions_send: ["coding", "messaging"],
      sessions_spawn: ["coding"],
      subagents: ["coding"],
      session_status: ["minimal", "coding", "messaging"],
      browser: [],
      canvas: [],
      message: ["messaging"],
      cron: ["coding"],
      gateway: [],
      nodes: [],
      agents_list: [],
      image: ["coding"],
      tts: [],
    });
  });

  it("assigns correct includeInOpenClawGroup for every tool", () => {
    const byId = Object.fromEntries(catalog.tools.map((t) => [t.id, t.includeInOpenClawGroup]));
    expect(byId).toEqual({
      read: false,
      write: false,
      edit: false,
      apply_patch: false,
      exec: false,
      process: false,
      web_search: true,
      web_fetch: true,
      memory_search: true,
      memory_get: true,
      sessions_list: true,
      sessions_history: true,
      sessions_send: true,
      sessions_spawn: true,
      subagents: true,
      session_status: true,
      browser: true,
      canvas: true,
      message: true,
      cron: true,
      gateway: true,
      nodes: true,
      agents_list: true,
      image: true,
      tts: true,
    });
  });

  it("parses all section order ids", () => {
    const sectionIds = catalog.sectionOrder.map((s) => s.id);
    expect(sectionIds).toEqual([
      "fs",
      "runtime",
      "web",
      "memory",
      "sessions",
      "ui",
      "messaging",
      "automation",
      "nodes",
      "agents",
      "media",
    ]);
  });
});

describe("parsePolicies", () => {
  const policies = parsePolicies(path.join(srcDir, "src"));

  it("parses aliases", () => {
    expect(policies.aliases).toEqual({
      bash: "exec",
      "apply-patch": "apply_patch",
    });
  });

  it("parses exact owner-only fallbacks", () => {
    expect(policies.ownerOnlyFallbacks.toSorted()).toEqual(
      ["cron", "gateway", "whatsapp_login"].toSorted(),
    );
  });

  it("parses exact subagent deny-always list", () => {
    expect(policies.subagentDenyAlways.toSorted()).toEqual(
      [
        "agents_list",
        "cron",
        "gateway",
        "memory_get",
        "memory_search",
        "session_status",
        "sessions_send",
        "whatsapp_login",
      ].toSorted(),
    );
  });

  it("parses exact subagent deny-leaf list", () => {
    expect(policies.subagentDenyLeaf.toSorted()).toEqual(
      ["sessions_list", "sessions_history", "sessions_spawn"].toSorted(),
    );
  });
});

describe("parsePipeline", () => {
  const pipeline = parsePipeline(path.join(srcDir, "src"));

  it("parses 7 pipeline steps", () => {
    expect(pipeline.steps.length).toBe(7);
  });

  it("all steps have stripPluginOnlyAllowlist", () => {
    for (const step of pipeline.steps) {
      expect(step.stripPluginOnlyAllowlist).toBe(true);
    }
  });
});
